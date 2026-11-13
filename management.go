package main

import (
	"encoding/json"
	"errors"
)

func dispatchRPC(method string, payload []byte) ([]byte, error) {
	switch method {
	case "usage.handle":
		if err := claudeRequests.capture(payload); err != nil {
			return errorEnvelope("request_log_failed", err.Error()), err
		}
		return okEnvelope(struct{}{})
	case "plugin.register", "plugin.reconfigure":
		if err := claudeRequests.configure(payload); err != nil {
			return errorEnvelope("invalid_config", err.Error()), err
		}
		return okEnvelope(pluginRegistration())
	case "management.register":
		return okEnvelope(managementRegistration())
	case "management.handle":
		var request managementRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return errorEnvelope("invalid_request", "invalid management request"), errors.New("invalid management request")
		}
		if request.Path == requestAPIPath {
			if request.Method != "GET" {
				return okEnvelope(textResponse(405, "method not allowed"))
			}
			page, err := claudeRequests.page(request.Query)
			if err != nil {
				return okEnvelope(jsonResponse(500, map[string]string{"error": err.Error()}))
			}
			return okEnvelope(jsonResponse(200, page))
		}
		return okEnvelope(servePanelResource(request))
	default:
		return errorEnvelope("unknown_method", "unknown method: "+method), errors.New("unknown method")
	}
}
