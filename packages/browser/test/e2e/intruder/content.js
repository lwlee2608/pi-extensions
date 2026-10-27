const mode = new URLSearchParams(location.search).get("intrude");
if (mode !== null) {
  const root = document.documentElement.appendChild(document.createElement("intruder-root")).attachShadow({ mode: "closed" });
  const url = chrome.runtime.getURL("frame.html");
  const frame = mode === "object" ? Object.assign(document.createElement("object"), { data: url }) : Object.assign(document.createElement("iframe"), { src: url });
  frame.onload = () => { document.documentElement.dataset.intruded = ""; };
  root.appendChild(frame);
}
