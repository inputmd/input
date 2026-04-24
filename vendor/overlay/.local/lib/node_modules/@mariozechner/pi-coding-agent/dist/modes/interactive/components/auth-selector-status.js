function getConfiguredLabel(authType) {
    return authType === "oauth" ? "subscription configured" : "api key configured";
}
export function getAuthSelectorIndicator(authType, credential, authStatus) {
    if (credential) {
        const label = getConfiguredLabel(credential.type);
        return credential.type === authType ? { kind: "configured", label } : { kind: "configured-other", label };
    }
    if (authType === "oauth") {
        return { kind: "unconfigured" };
    }
    if (authStatus?.source === "runtime") {
        return { kind: "runtime" };
    }
    if (authStatus?.source === "environment") {
        return { kind: "environment", label: authStatus.label ?? "API key" };
    }
    if (authStatus?.source === "fallback") {
        return { kind: "fallback" };
    }
    return { kind: "unconfigured" };
}
//# sourceMappingURL=auth-selector-status.js.map