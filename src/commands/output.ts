import { styleText } from "node:util";

type Style = Parameters<typeof styleText>[0];

export type TextSink = { write: (text: string) => unknown };

export type Output = {
  /** `[planeward] …` on stdout. */
  info: (line: string) => void;
  /** `[planeward] …` in yellow on stderr. */
  warn: (line: string) => void;
  /** `[planeward] …` in red on stderr. */
  error: (line: string) => void;
  /** One line of the app's output, prefixed `[app]`. */
  app: (line: string, stream: "stdout" | "stderr") => void;
  /** Unprefixed text on stdout (banner, help). */
  plain: (text: string) => void;
  paint: (style: Style, text: string) => string;
};

export type OutputOptions = {
  stdout?: TextSink;
  stderr?: TextSink;
  color?: boolean;
};

function hasColors(): boolean {
  const stdout = process.stdout as NodeJS.WriteStream;
  return Boolean(stdout.isTTY && stdout.hasColors?.());
}

export function createOutput(options: OutputOptions = {}): Output {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const color = options.color ?? hasColors();
  const paint = (style: Style, text: string) =>
    color ? styleText(style, text, { validateStream: false }) : text;
  const cli = paint("magenta", "[planeward]");
  const app = paint("cyan", "[app]");

  return {
    paint,
    info: (line) => stdout.write(`${cli} ${line}\n`),
    warn: (line) => stderr.write(`${cli} ${paint("yellow", line)}\n`),
    error: (line) => stderr.write(`${cli} ${paint("red", line)}\n`),
    app: (line, stream) =>
      (stream === "stdout" ? stdout : stderr).write(`${app} ${line}\n`),
    plain: (text) => stdout.write(text.endsWith("\n") ? text : `${text}\n`),
  };
}

/** Splits a byte stream into lines; `flush` emits a trailing partial line. */
export function createLineSplitter(onLine: (line: string) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        onLine(buffer.slice(0, index).replace(/\r$/, ""));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = "";
    },
  };
}
