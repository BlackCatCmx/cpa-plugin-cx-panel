package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

const requestLogLimit = 2 * 1024 * 1024
const requestAPIPath = "/v0/management/plugins/" + pluginID + "/requests"

// requestRecord deliberately excludes bodies, headers and client credentials.
type requestRecord struct {
	RequestID       string
	TraceID         string
	AuthIndex       string
	SessionID       string
	Model           string
	Alias           string
	ResponseModel   string
	ReasoningEffort string
	RequestedAt     time.Time
	Failed          bool
	StatusCode      int
	Detail          struct {
		InputTokens         int64
		OutputTokens        int64
		CacheReadTokens     int64
		CacheCreationTokens int64
	}
}

type requestLog struct {
	mu        sync.Mutex
	enabled   bool
	dir       string
	limit     int64
	lastError string
}

var claudeRequests = &requestLog{dir: filepath.Join("data", pluginID), limit: requestLogLimit}

func (l *requestLog) configure(payload []byte) error {
	var lifecycle struct {
		ConfigYAML []byte `json:"config_yaml"`
	}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &lifecycle); err != nil {
			return err
		}
	}
	var config struct {
		Enabled bool `yaml:"claude_request_logging"`
	}
	if err := yaml.Unmarshal(lifecycle.ConfigYAML, &config); err != nil {
		return fmt.Errorf("parse request logging config: %w", err)
	}
	l.mu.Lock()
	l.enabled = config.Enabled
	l.mu.Unlock()
	return nil
}

func (l *requestLog) isEnabled() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.enabled
}

func (l *requestLog) capture(payload []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.enabled {
		return nil
	}
	var incoming struct {
		requestRecord
		Provider string
		Failure  struct{ StatusCode int }
	}
	if err := json.Unmarshal(payload, &incoming); err != nil {
		return fmt.Errorf("decode usage: %w", err)
	}
	if incoming.Provider != "claude" {
		return nil
	}
	err := l.append(incoming.requestRecord, incoming.Failure.StatusCode)
	if err != nil {
		l.lastError = err.Error()
	} else {
		l.lastError = ""
	}
	return err
}

// append opens files only for the duration of a write; no background writer is needed.
func (l *requestLog) append(record requestRecord, status int) error {
	record.StatusCode = status
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if int64(len(raw)) > l.limit {
		return errors.New("request summary exceeds log file size")
	}
	if err := os.MkdirAll(l.dir, 0700); err != nil {
		return fmt.Errorf("create request log directory: %w", err)
	}
	current := filepath.Join(l.dir, "requests.jsonl")
	previous := filepath.Join(l.dir, "requests.previous.jsonl")
	info, err := os.Stat(current)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if info != nil && info.Size()+int64(len(raw))+1 > l.limit {
		if err := os.Remove(previous); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("rotate previous request log: %w", err)
		}
		if err := os.Rename(current, previous); err != nil {
			return fmt.Errorf("rotate request log: %w", err)
		}
		info = nil
	}
	f, err := os.OpenFile(current, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
	if err != nil {
		return fmt.Errorf("open request log: %w", err)
	}
	if info != nil && info.Size() > 0 {
		var last [1]byte
		if _, err := f.ReadAt(last[:], info.Size()-1); err != nil {
			return errors.Join(err, f.Close())
		}
		if last[0] != '\n' {
			raw = append([]byte{'\n'}, raw...)
		}
	}
	_, errWrite := f.Write(raw)
	errClose := f.Close()
	return errors.Join(errWrite, errClose)
}

type requestPage struct {
	Skipped    int             `json:"skipped"`
	Enabled    bool            `json:"enabled"`
	Records    []requestRecord `json:"records"`
	Next       string          `json:"next"`
	WriteError string          `json:"write_error"`
}

func (l *requestLog) page(query map[string][]string) (requestPage, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	page := requestPage{Records: []requestRecord{}, WriteError: l.lastError, Enabled: l.enabled}
	get := func(key string) string {
		if len(query[key]) > 0 {
			return query[key][0]
		}
		return ""
	}
	auth, session, before := get("auth"), get("session"), get("before")
	if auth == "" {
		return page, errors.New("account is required")
	}
	seeking := before != ""
	done := false
	for _, name := range []string{"requests.jsonl", "requests.previous.jsonl"} {
		err := reverseLogLines(filepath.Join(l.dir, name), func(line []byte) error {
			var record requestRecord
			if err := json.Unmarshal(line, &record); err != nil {
				page.Skipped++
				return nil
			}
			if seeking {
				if record.RequestID == before {
					seeking = false
				}
				return nil
			}
			if record.AuthIndex != auth || (session != "" && record.SessionID != session) {
				return nil
			}
			if get("mismatch") == "1" && !modelNameDiffers(record) {
				return nil
			}
			if len(page.Records) == 50 {
				page.Next = page.Records[49].RequestID
				done = true
				return io.EOF
			}
			page.Records = append(page.Records, record)
			return nil
		})
		if err != nil {
			return page, err
		}
		if done {
			break
		}
	}
	if seeking {
		return page, errors.New("记录已轮换，请刷新列表")
	}
	return page, nil
}

func modelNameDiffers(record requestRecord) bool {
	return strings.TrimSpace(record.ResponseModel) != "" && !strings.EqualFold(strings.TrimSpace(record.Model), strings.TrimSpace(record.ResponseModel))
}

// reverseLogLines reads from the tail in small blocks instead of loading the file.
func reverseLogLines(path string, visit func([]byte) error) (err error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, f.Close()) }()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	var pending []byte
	for offset := info.Size(); offset > 0; {
		n := min(offset, 16*1024)
		offset -= n
		block := make([]byte, int(n))
		if _, err := f.ReadAt(block, offset); err != nil {
			return err
		}
		pending = append(block, pending...)
		for {
			i := bytes.LastIndexByte(pending, '\n')
			if i < 0 {
				break
			}
			line := pending[i+1:]
			if len(line) > 0 {
				if err := visit(line); err != nil {
					if errors.Is(err, io.EOF) {
						return nil
					}
					return err
				}
			}
			pending = pending[:i]
		}
	}
	if len(pending) > 0 {
		if err := visit(pending); !errors.Is(err, io.EOF) {
			return err
		}
	}
	return nil
}
