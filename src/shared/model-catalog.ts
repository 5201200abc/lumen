import type { LlamaStatus, Settings } from "./types";
import { detectReasoningControl } from "./types";

const LOCAL_ENDPOINT = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/v1\/?$/i;

export function reconcileModelCatalog(
  settings: Settings,
  status: LlamaStatus
): Settings["llamaModels"] {
  const activeEndpoint =
    settings.llamaEndpoints.find((endpoint) => endpoint.url === settings.llamaUrl) ||
    settings.llamaEndpoints[0];
  const localEndpoint = settings.llamaEndpoints.find((endpoint) => LOCAL_ENDPOINT.test(endpoint.url));
  if (!activeEndpoint || !localEndpoint) return settings.llamaModels;

  const replacedEndpointIds = new Set(
    settings.llamaEndpoints
      .filter((endpoint) => LOCAL_ENDPOINT.test(endpoint.url))
      .map((endpoint) => endpoint.id)
  );
  const preserved = settings.llamaModels.filter((model) => !replacedEndpointIds.has(model.endpointId));
  const localModels = status.localModels.map((model) => ({
    id: `local:${model.name}`,
    name: model.name,
    endpointId: localEndpoint.id,
    reasoningControl: model.reasoningControl,
    reasoningEfforts: model.reasoningEfforts,
    source: "local" as const
  }));
  const remoteModels = activeEndpoint.id === localEndpoint.id
    ? []
    : status.models.map((name) => ({
        id: `${activeEndpoint.id}:${name}`,
        name,
        endpointId: activeEndpoint.id,
        reasoningControl: detectReasoningControl(name),
        source: "remote" as const
      }));
  return [...preserved, ...localModels, ...remoteModels].slice(0, 5);
}
