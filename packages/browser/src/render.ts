import { keyHint, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

export interface CallArgs {
  action?: string;
  url?: string;
  tabId?: number;
  newTab?: boolean;
  ref?: number;
  point?: number[];
  to?: number[];
  delta?: number[];
  region?: number[];
  button?: string;
  clickCount?: number;
  text?: string;
  code?: string;
  keys?: string;
}

export function clean(text: string): string {
  return stripVTControlCharacters(text.replace(/\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\|$)/g, ""))
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

const xy = (point: number[]) => `(${point.join(", ")})`;

function short(text: string, max = 60): string {
  const line = clean(text).replace(/\n/g, "⏎");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function target(args: CallArgs, cut: (text: string, max?: number) => string): string {
  const at = args.ref !== undefined ? `[${args.ref}]` : args.point ? xy(args.point) : "";
  switch (args.action) {
    case "navigate": return `${cut(args.url?.replace(/^https?:\/\//, "") ?? "", 80)}${args.newTab ? " in new tab" : ""}`;
    case "click": return [at, args.button === "right" && "right", args.clickCount && args.clickCount > 1 && `×${args.clickCount}`].filter(Boolean).join(" ");
    case "scroll": return args.delta ? `${at} by ${xy(args.delta)}` : at;
    case "drag": return args.point && args.to ? `${xy(args.point)} → ${xy(args.to)}` : at;
    case "type": return [at, args.text !== undefined && `"${cut(args.text)}"`].filter(Boolean).join(" ");
    case "keys": return [at, args.keys && cut(args.keys)].filter(Boolean).join(" ");
    case "zoom": return args.region ? `${xy(args.region.slice(0, 2))} → ${xy(args.region.slice(2))}` : "";
    case "hover": return at;
    default: return "";
  }
}

const PREVIEW = 5;

function more(count: number, theme: Theme): string {
  return `${theme.fg("muted", `… ${count} more line${count === 1 ? "" : "s"},`)} ${keyHint("app.tools.expand", "to expand")}`;
}

export function renderCall(args: CallArgs, theme: Theme, expanded = false): Text {
  const parts = target(args, expanded ? clean : short);
  const rows = [`${theme.fg("toolTitle", theme.bold(`Browser ${args.action ?? ""}`))}${parts ? ` ${theme.fg("accent", parts)}` : ""}`];
  if (args.action === "eval" && args.code) {
    const code = clean(args.code).split("\n");
    const shown = expanded ? code : code.slice(0, PREVIEW);
    rows.push(...shown.map(line => theme.fg("muted", `  ${line}`)));
    if (code.length > shown.length) rows.push(more(code.length - shown.length, theme));
  }
  return new Text(rows.join("\n"), 0, 0);
}

export function renderResult(result: AgentToolResult<unknown>, expanded: boolean, theme: Theme, action?: string, isError = false): Component {
  const lines = clean(result.content.flatMap(item => item.type === "text" ? [item.text] : []).join("\n")).trimEnd().split("\n");
  if (isError) return new Text(theme.fg("error", lines.join("\n")), 0, 0);
  if (expanded) return new Text(lines.map(line => theme.fg("toolOutput", line)).join("\n"), 0, 0);
  const shown = lines.slice(0, action === "eval" ? PREVIEW : 1);
  const rows = shown.map(line => theme.fg("toolOutput", line));
  if (lines.length > shown.length) rows.push(more(lines.length - shown.length, theme));
  return { render: width => rows.map(row => truncateToWidth(row, width)), invalidate() {} };
}
