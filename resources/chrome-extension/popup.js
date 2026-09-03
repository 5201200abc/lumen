const dot = document.querySelector("#dot");
const label = document.querySelector("#label");

function render(status) {
  const connected = status?.connected === true;
  dot.classList.toggle("connected", connected);
  label.textContent = connected ? `Connected to Lumen · ${status.port}` : "Lumen is not connected";
}

chrome.runtime.sendMessage({ type: "lumen-get-status" }).then(render).catch(() => render(null));
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "lumen-bridge-status") render(message);
});
