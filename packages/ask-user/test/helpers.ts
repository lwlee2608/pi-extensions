import { type Theme } from "@earendil-works/pi-coding-agent";

const identity = (_color: string, text: string) => text;
export const theme = { fg: identity, bg: identity, bold: (text: string) => text } as Theme;
