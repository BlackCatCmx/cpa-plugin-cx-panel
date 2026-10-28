package main

import (
	_ "embed"
	"encoding/json"
)

const (
	abiVersion   uint32 = 1
	pluginID            = "cpa-plugin-cx-panel"
	pluginName          = "CPA CX Panel"
	pluginAuthor        = "BlackCatCmx"
	panelPath           = "/panel"
)

//go:embed registry.json
var registryJSON []byte

var pluginVersion = func() string {
	var registry struct {
		Plugins []struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(registryJSON, &registry); err != nil {
		panic("parse embedded registry.json: " + err.Error())
	}
	for _, plugin := range registry.Plugins {
		if plugin.ID == pluginID && plugin.Version != "" {
			return plugin.Version
		}
	}
	panic("plugin version missing from embedded registry.json")
}()

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type managementRequest struct {
	Method string              `json:"Method"`
	Path   string              `json:"Path"`
	Header map[string][]string `json:"Headers"`
	Query  map[string][]string `json:"Query"`
	Body   []byte              `json:"Body"`
}

type managementResponse struct {
	StatusCode int                 `json:"StatusCode"`
	Headers    map[string][]string `json:"Headers"`
	Body       []byte              `json:"Body"`
}
