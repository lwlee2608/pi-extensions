const mode = new URLSearchParams(location.search).get("intrude");
if (mode !== null) {
  const root = document.documentElement.appendChild(document.createElement("intruder-root")).attachShadow({ mode: "closed" });
  const add = () => root.appendChild(Object.assign(document.createElement("iframe"), { src: chrome.runtime.getURL("frame.html") }));
  add();
  if (mode === "stubborn") new MutationObserver(() => root.querySelector("iframe") || add()).observe(root, { childList: true });
}
