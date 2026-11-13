package main

import "encoding/json"

func pluginRegistration() any {
	return struct {
		SchemaVersion uint32         `json:"schema_version"`
		Metadata      map[string]any `json:"metadata"`
		Capabilities  map[string]any `json:"capabilities"`
	}{
		SchemaVersion: 1,
		Metadata: map[string]any{
			"Name":             pluginName,
			"Version":          pluginVersion,
			"Author":           pluginAuthor,
			"GitHubRepository": "https://github.com/BlackCatCmx/cpa-plugin-cx-panel",
			"Logo":             "",
			"ConfigFields": []map[string]any{{
				"Name":        "refresh_user_agent",
				"Type":        "string",
				"EnumValues":  []string{},
				"Description": "User-Agent used for manual Codex quota refreshes. Empty inherits the CPA Codex default.",
			}, {
				"Name":        "claude_client_version",
				"Type":        "string",
				"EnumValues":  []string{},
				"Description": "Claude client version used to generate quota and profile User-Agents, for example 2.1.321. Empty uses the built-in version.",
			}, {
				"Name":        "claude_request_logging",
				"Type":        "boolean",
				"Description": "Record Claude request summaries to rotating JSONL files. Disabled by default; existing logs remain readable when disabled.",
			}},
		},
		Capabilities: map[string]any{"management_api": true, "usage_plugin": claudeRequests.isEnabled()},
	}
}

func managementRegistration() any {
	return struct {
		Routes    []map[string]string `json:"routes"`
		Resources []map[string]string `json:"resources"`
	}{Routes: []map[string]string{{"Method": "GET", "Path": requestAPIPath}}, Resources: []map[string]string{
		{
			"Path":        panelPath,
			"Menu":        "Codex / Claude 额度",
			"Description": "Codex and Claude account quota panel",
		},
		{"Path": "/panel-app.mjs"},
		{"Path": "/panel-logic.mjs"},
		{"Path": "/requests.mjs"},
	}}
}

func okEnvelope(result any) ([]byte, error) {
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{OK: true, Result: raw})
}

func errorEnvelope(code, message string) []byte {
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message}})
	return raw
}
