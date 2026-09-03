export type ChromeControlMode = "auto" | "extension" | "isolated";
export type ChromeController = "extension" | "isolated";

export function selectChromeController(opts: {
  mode: ChromeControlMode;
  extensionConnected: boolean;
  activeController: ChromeController | null;
  requireExisting: boolean;
}): ChromeController {
  if (opts.mode === "isolated") return "isolated";
  if (opts.activeController === "isolated" && opts.requireExisting) return "isolated";
  if (opts.activeController === "extension" && !opts.extensionConnected && opts.requireExisting) {
    throw new Error("Lumen Browser Bridge disconnected from the active Chrome task.");
  }
  if (opts.activeController === "extension" && opts.requireExisting) return "extension";
  if (opts.extensionConnected) return "extension";
  throw new Error(
    "Lumen Browser Bridge extension is not connected. Enable the extension, or explicitly choose Isolated profile in Settings."
  );
}
