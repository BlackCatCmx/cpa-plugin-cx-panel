package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestPluginRegistration(t *testing.T) {
	raw, err := dispatchRPC("plugin.register", nil)
	if err != nil {
		t.Fatalf("dispatchRPC() error = %v", err)
	}
	var response envelope
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if !response.OK {
		t.Fatal("plugin.register returned a failed envelope")
	}
	var result struct {
		SchemaVersion uint32 `json:"schema_version"`
		Metadata      struct {
			Name         string `json:"Name"`
			Version      string `json:"Version"`
			ConfigFields []struct {
				Name string `json:"Name"`
				Type string `json:"Type"`
			} `json:"ConfigFields"`
		} `json:"metadata"`
		Capabilities map[string]bool `json:"capabilities"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatalf("decode registration: %v", err)
	}
	if result.SchemaVersion != 1 || result.Metadata.Name != pluginName || !result.Capabilities["management_api"] {
		t.Fatalf("unexpected registration: %#v", result)
	}
	registryRaw, err := os.ReadFile("registry.json")
	if err != nil {
		t.Fatal(err)
	}
	var registry struct {
		Plugins []struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(registryRaw, &registry); err != nil {
		t.Fatal(err)
	}
	var expectedVersion string
	for _, plugin := range registry.Plugins {
		if plugin.ID == pluginID {
			expectedVersion = plugin.Version
			break
		}
	}
	if expectedVersion == "" || result.Metadata.Version != expectedVersion {
		t.Fatalf("registered version = %q, registry version = %q", result.Metadata.Version, expectedVersion)
	}
	fields := make(map[string]string)
	for _, field := range result.Metadata.ConfigFields {
		fields[field.Name] = field.Type
	}
	if fields["refresh_user_agent"] != "string" || fields["claude_client_version"] != "string" {
		t.Fatalf("unexpected config fields: %#v", fields)
	}
}

func TestManagementRegistration(t *testing.T) {
	raw, err := dispatchRPC("management.register", nil)
	if err != nil {
		t.Fatalf("dispatchRPC() error = %v", err)
	}
	var response envelope
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	var result struct {
		Resources []map[string]string `json:"resources"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatalf("decode management registration: %v", err)
	}
	if len(result.Resources) != 3 || result.Resources[0]["Path"] != panelPath || result.Resources[1]["Path"] != "/panel-app.mjs" {
		t.Fatalf("unexpected resources: %#v", result.Resources)
	}
}
