package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRequestLogCaptureAndPrivacy(t *testing.T) {
	l := &requestLog{dir: t.TempDir(), limit: requestLogLimit, enabled: true}
	if err := l.capture([]byte(`{"Provider":"claude","RequestID":"one","AuthIndex":"a","Model":"opus","ResponseModel":"sonnet","SessionID":"session","APIKey":"secret","Failure":{"StatusCode":400,"Body":"secret"},"Detail":{"CacheReadTokens":12,"CacheCreationTokens":34}}`)); err != nil {
		t.Fatal(err)
	}
	if err := l.capture([]byte(`{"Provider":"codex","RequestID":"other"}`)); err != nil {
		t.Fatal(err)
	}
	page, err := l.page(map[string][]string{"auth": {"a"}, "mismatch": {"1"}, "session": {"session"}})
	if err != nil || len(page.Records) != 1 {
		t.Fatalf("page: %+v, %v", page, err)
	}
	if page.Records[0].Detail.CacheReadTokens != 12 || page.Records[0].Detail.CacheCreationTokens != 34 || page.Records[0].StatusCode != 400 {
		t.Fatalf("record: %+v", page.Records[0])
	}
	raw, err := os.ReadFile(filepath.Join(l.dir, "requests.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "secret") {
		t.Fatal("sensitive fields persisted")
	}
}

func TestRequestLogPaginationAndRotation(t *testing.T) {
	l := &requestLog{dir: t.TempDir(), limit: 22000, enabled: true}
	for i := 0; i < 110; i++ {
		payload := fmt.Sprintf(`{"Provider":"claude","RequestID":"id-%d","AuthIndex":"a","Model":"opus","ResponseModel":"opus"}`, i)
		if err := l.capture([]byte(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(l.dir, "requests.previous.jsonl")); err != nil {
		t.Fatal("expected rotation:", err)
	}
	query := map[string][]string{"auth": {"a"}}
	first, err := l.page(query)
	if err != nil || len(first.Records) != 50 || first.Records[0].RequestID != "id-109" {
		t.Fatalf("first page: %+v, %v", first, err)
	}
	query["before"] = []string{first.Next}
	second, err := l.page(query)
	if err != nil || len(second.Records) != 50 || second.Records[0].RequestID != "id-59" {
		t.Fatalf("second page: %+v, %v", second, err)
	}
	query["before"] = []string{second.Next}
	third, err := l.page(query)
	if err != nil || len(third.Records) != 10 || third.Next != "" {
		t.Fatalf("third page: %+v, %v", third, err)
	}
	query["before"] = []string{"expired"}
	if _, err := l.page(query); err == nil {
		t.Fatal("missing cursor must be visible")
	}
}

func TestRequestLogWriteFailureVisible(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(dir, []byte("occupied"), 0600); err != nil {
		t.Fatal(err)
	}
	l := &requestLog{dir: dir, limit: requestLogLimit, enabled: true}
	if err := l.capture([]byte(`{"Provider":"claude","RequestID":"one"}`)); err == nil || l.lastError == "" {
		t.Fatal("write failure was hidden")
	}
}

func TestRequestLogManagementRPC(t *testing.T) {
	old := claudeRequests
	claudeRequests = &requestLog{dir: t.TempDir(), limit: requestLogLimit, enabled: true}
	t.Cleanup(func() { claudeRequests = old })
	if _, err := dispatchRPC("usage.handle", []byte(`{"Provider":"claude","RequestID":"one","AuthIndex":"a"}`)); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(managementRequest{Method: "GET", Path: requestAPIPath, Query: map[string][]string{"auth": {"a"}}})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := dispatchRPC("management.handle", payload)
	if err != nil || !strings.Contains(string(raw), `"ok":true`) {
		t.Fatalf("RPC: %s, %v", raw, err)
	}
	var reply envelope
	if err := json.Unmarshal(raw, &reply); err != nil {
		t.Fatal(err)
	}
	var response managementResponse
	if err := json.Unmarshal(reply.Result, &response); err != nil {
		t.Fatal(err)
	}
	var page requestPage
	if err := json.Unmarshal(response.Body, &page); err != nil || len(page.Records) != 1 {
		t.Fatalf("API: %s, %v", response.Body, err)
	}
	for _, path := range []string{"/requests", "/v0/resource/plugins/" + pluginID + "/requests"} {
		public := servePanelResource(managementRequest{Method: "GET", Path: path, Query: map[string][]string{"auth": {"a"}}})
		if public.StatusCode != 404 || strings.Contains(string(public.Body), "one") {
			t.Fatalf("public request data: %+v", public)
		}
	}
}

func TestRequestLogInterruptedLine(t *testing.T) {
	l := &requestLog{dir: t.TempDir(), limit: requestLogLimit, enabled: true}
	path := filepath.Join(l.dir, "requests.jsonl")
	if err := os.WriteFile(path, []byte("{\"RequestID\":\"old\",\"AuthIndex\":\"a\"}\n{\"RequestID\":\"partial"), 0600); err != nil {
		t.Fatal(err)
	}
	page, err := l.page(map[string][]string{"auth": {"a"}})
	if err != nil || len(page.Records) != 1 || page.Skipped != 1 {
		t.Fatalf("interrupted tail: %+v, %v", page, err)
	}
	if err := l.capture([]byte(`{"Provider":"claude","RequestID":"new","AuthIndex":"a"}`)); err != nil {
		t.Fatal(err)
	}
	page, err = l.page(map[string][]string{"auth": {"a"}})
	if err != nil || len(page.Records) != 2 || page.Skipped != 1 || page.Records[0].RequestID != "new" {
		t.Fatalf("append after interruption: %+v, %v", page, err)
	}
}

func TestRequestLogSwitch(t *testing.T) {
	l := &requestLog{dir: filepath.Join(t.TempDir(), "logs"), limit: requestLogLimit}
	if err := l.capture([]byte(`invalid while disabled`)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(l.dir); !os.IsNotExist(err) {
		t.Fatal("disabled logger touched disk")
	}
	configure := func(enabled bool) {
		t.Helper()
		raw, err := json.Marshal(map[string]any{"config_yaml": []byte(fmt.Sprintf("claude_request_logging: %t\n", enabled))})
		if err != nil {
			t.Fatal(err)
		}
		if err := l.configure(raw); err != nil {
			t.Fatal(err)
		}
	}
	configure(true)
	if err := l.capture([]byte(`{"Provider":"claude","RequestID":"one","AuthIndex":"a"}`)); err != nil {
		t.Fatal(err)
	}
	configure(false)
	if err := l.capture([]byte(`{"Provider":"claude","RequestID":"two","AuthIndex":"a"}`)); err != nil {
		t.Fatal(err)
	}
	page, err := l.page(map[string][]string{"auth": {"a"}})
	if err != nil || page.Enabled || len(page.Records) != 1 {
		t.Fatalf("disabled history: %+v, %v", page, err)
	}
}
