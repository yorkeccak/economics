import { z } from "zod";
import { tool } from "ai";
import mammoth from "mammoth";
// import pdfParse from "pdf-parse"; // Removed - using AI SDK instead
import { Valyu } from "valyu-js";
import { track } from "@vercel/analytics/server";
import { PolarEventTracker } from "./polar-events";
import { Daytona } from "@daytonaio/sdk";
import { createHash } from "node:crypto";

const DAYTONA_EXECUTION_TIMEOUT_MS = parseInt(
  process.env.DAYTONA_EXECUTION_TIMEOUT_MS || "60000"
);

// Helper function to handle API calls with timeout and retry logic
async function callValyuWithTimeout(
  valyu: Valyu,
  searchQuery: string,
  searchOptions: any,
  timeoutMs: number = parseInt(process.env.VALYU_API_TIMEOUT || "30000"), // Configurable timeout
  maxRetries: number = parseInt(process.env.VALYU_API_RETRIES || "2") // Configurable retries
): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`Request timeout after ${timeoutMs}ms`)),
          timeoutMs
        );
      });

      // Race between the actual API call and timeout
      const result = await Promise.race([
        valyu.search(searchQuery, searchOptions),
        timeoutPromise,
      ]);

      return result;
    } catch (error: any) {
      lastError = error;

      // If it's a timeout or network error, retry
      if (
        error.message.includes("timeout") ||
        error.message.includes("ECONNRESET") ||
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ETIMEDOUT")
      ) {
        if (attempt < maxRetries) {
          // Exponential backoff: wait 1s, then 2s, then 4s
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      // If it's not a retryable error, or we've exhausted retries, throw
      throw error;
    }
  }

  throw lastError || new Error("All retry attempts failed");
}

// In-flight dedupe
const inflight = new Map<string, Promise<any>>();
function inflightKey(tool: string, query: string, opts?: any) {
  const queryStr = typeof query === "string" ? query : String(query || "");
  return `${tool}::${queryStr.trim().toLowerCase()}::${JSON.stringify(
    opts || {}
  )}`;
}

async function once<T>(
  tool: string,
  query: string,
  opts: any,
  run: () => Promise<T>
): Promise<T> {
  const key = inflightKey(tool, query, opts);
  if (inflight.has(key)) return inflight.get(key)! as Promise<T>;
  const p = (async () => {
    try {
      return await run();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// URL normalization + ID helpers
function canonQuery(q?: string) {
  const queryStr = typeof q === "string" ? q : String(q || "");
  return queryStr.trim().replace(/\s+/g, " ").toLowerCase();
}

function canonOptions(input: any): any {
  if (Array.isArray(input)) {
    return [...input]
      .map(canonOptions)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (input && typeof input === "object") {
    const out: any = {};
    Object.keys(input)
      .sort()
      .forEach((k) => {
        const v = (input as any)[k];
        if (v === undefined || v === null) return;
        out[k] = canonOptions(v);
      });
    return out;
  }
  return input;
}

function buildToolKey(tool: string, query: string, opts: any) {
  return `${tool}::${canonQuery(query)}::${JSON.stringify(canonOptions(opts))}`;
}
function normalizeUrl(url?: string) {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    // strip tracking params
    for (const k of Array.from(u.searchParams.keys())) {
      if (k.startsWith("utm_") || k === "ref" || k === "ref_src")
        u.searchParams.delete(k);
    }
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    const qs = u.searchParams.toString();
    return `${u.protocol}//${host}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return (url || "").trim();
  }
}
function keyToUuid(key: string) {
  const hash = createHash("sha256").update(key).digest();
  const bytes = Buffer.from(hash.slice(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function extractArxivId(url?: string) {
  if (!url) return undefined;
  const m = url.match(/arxiv\.org\/(?:abs|pdf)\/([\w.\-]+)/i);
  return m?.[1];
}
function extractDoi(s?: string) {
  if (!s) return undefined;
  const m = s.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return m?.[0]?.toLowerCase();
}

function parseApiContent(content: unknown, maxDepth = 4): any {
  if (typeof content !== "string") {
    return content;
  }

  let current: any = content;
  for (let attempt = 0; attempt < maxDepth; attempt++) {
    const trimmed = typeof current === "string" ? current.trim() : current;

    if (typeof trimmed !== "string") {
      return trimmed;
    }

    if (!trimmed) {
      return "";
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        current = parsed;
        continue;
      }
      return parsed;
    } catch {
      const hasWrappingQuotes =
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"));

      if (hasWrappingQuotes) {
        current = trimmed.slice(1, -1);
        continue;
      }

      const unescaped = trimmed
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t");

      if (unescaped !== trimmed) {
        current = unescaped;
        continue;
      }

      break;
    }
  }

  return current;
}

function resultId(r: any) {
  const key =
    r.nct_id ||
    r.data?.nct_id ||
    r.metadata?.pmid ||
    r.pmid ||
    r.metadata?.doi ||
    r.doi ||
    r.metadata?.setid ||
    extractArxivId(r.url) ||
    normalizeUrl(r.url) ||
    `${(r.title || "").toLowerCase()}|${(r.source || "").toLowerCase()}|${
      r.date || ""
    }`;
  return keyToUuid(key);
}
function dedupeBy<T>(arr: T[], getId: (x: T) => string) {
  const seen = new Set<string>();
  return arr.filter((x) => {
    const id = getId(x);
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function extractMissingModuleName(message?: string) {
  if (!message) return null;
  const match = message.match(
    /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/
  );
  return match ? match[1] : null;
}

function escapeModuleTag(text?: string | null) {
  if (!text) return text || "";
  return text.replace(/<module>/g, "&lt;module&gt;");
}

type ValidationStatus = "pass" | "fail";

type ValidationItem = {
  label: string;
  status: ValidationStatus;
  detail: string;
};

function formatValidationSummary(items: ValidationItem[]) {
  if (!items.length) return "";
  const lines = items.map((item) => {
    const icon = item.status === "pass" ? "✅" : "❌";
    return `${icon} ${item.label}: ${item.detail}`;
  });
  return `🔍 **Validation Checks**\n${lines.join("\n")}`;
}

function extractImportedModules(code: string) {
  const modules = new Set<string>();
  const lines = code.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const fromMatch = line.match(/^from\s+([A-Za-z0-9_.]+)\s+import\s+/);
    if (fromMatch) {
      const base = fromMatch[1];
      if (!base.startsWith(".")) {
        modules.add(base.split(".")[0]);
      }
      continue;
    }

    const importMatch = line.match(/^import\s+(.+)/);
    if (importMatch) {
      const targets = importMatch[1]
        .split(",")
        .map((segment) => segment.trim())
        .filter(Boolean);

      for (const target of targets) {
        if (target.startsWith(".")) continue;
        const base = target
          .split(/\s+as\s+/i)[0]
          .split(".")[0]
          .trim();
        if (base) modules.add(base);
      }
    }
  }

  return Array.from(modules);
}

function detectCodeIssues(code: string): ValidationItem | null {
  const lines = code.split(/\r?\n/);
  const numpyAliases = new Set<string>();
  let importsNumpy = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const importAlias = line.match(
      /^import\s+numpy\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/
    );
    if (importAlias) {
      numpyAliases.add(importAlias[1]);
      importsNumpy = true;
      continue;
    }

    if (/^import\s+numpy\b/.test(line) || /^from\s+numpy\b/.test(line)) {
      numpyAliases.add("numpy");
      importsNumpy = true;
    }
  }

  if (importsNumpy) {
    const usesNpIdentifier = /\bnp\s*\./.test(code);
    const overridesNp = /(^|[^A-Za-z0-9_])np\s*=\s*/.test(code);
    const hasNpAlias = numpyAliases.has("np");

    if (usesNpIdentifier && !hasNpAlias) {
      return {
        label: "NumPy Alias Safety",
        status: "fail",
        detail:
          "The code calls `np.` functions but never assigns the `np` alias. Import NumPy as `np` (not allowed here) or reference the chosen alias consistently.",
      };
    }

    if (overridesNp) {
      return {
        label: "NumPy Alias Safety",
        status: "fail",
        detail:
          "The identifier `np` is reassigned in the script, so subsequent calls like `np.exp()` will break. Avoid assigning new values to `np` after importing NumPy.",
      };
    }
  }

  return null;
}

// Per-request dedupe across tools (no TTL; resets each server process restart)
const seenByRequest = new Map<string, Set<string>>();
function dedupeAgainstRequest<T>(
  requestId: string | undefined,
  items: T[],
  getId: (x: T) => string
) {
  if (!requestId) return items;
  let bag = seenByRequest.get(requestId);
  if (!bag) {
    bag = new Set();
    seenByRequest.set(requestId, bag);
  }
  return items.filter((x) => {
    const id = getId(x);
    if (!id || bag!.has(id)) return false;
    bag!.add(id);
    return true;
  });
}

// Per-session in-memory memo (no TTL). Collapses repeat queries across the same chat session.
const memoBySession = new Map<string, Map<string, any>>();
const SESSION_MEMO_MAX_KEYS = 200;

async function withSessionMemo<T>(
  sessionId: string | undefined,
  key: string,
  run: () => Promise<T>
): Promise<T> {
  if (!sessionId) return run();
  let bag = memoBySession.get(sessionId);
  if (!bag) {
    bag = new Map();
    memoBySession.set(sessionId, bag);
  }
  if (bag.has(key)) return bag.get(key) as T;
  const value = await run();
  // Simple LRU-ish: evict oldest when at capacity
  if (bag.size >= SESSION_MEMO_MAX_KEYS) {
    const firstKey = bag.keys().next().value;
    if (firstKey) bag.delete(firstKey);
  }
  bag.set(key, value);
  return value;
}

function logDedupe(
  tool: string,
  requestId: string | undefined,
  raw: number,
  mapped: number,
  unique: number,
  final: any[]
) {}

export const economicsTools = {
  // File reading tools - allow the model to read user-provided files via URLs
  readTextFromUrl: tool({
    description:
      "Fetch a plain text or text-like file from a URL and return its contents. Accepts text/*, application/json, and common code/text formats.",
    inputSchema: z.object({
      url: z.string().url().describe("Publicly accessible URL to the file"),
      maxBytes: z
        .number()
        .min(1024)
        .max(25 * 1024 * 1024)
        .optional()
        .default(10 * 1024 * 1024)
        .describe("Maximum bytes to download (default 10MB, max 25MB)"),
      charset: z
        .string()
        .optional()
        .describe("Optional character set hint, e.g., 'utf-8'"),
    }),
    execute: async ({ url, maxBytes, charset }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          return `❌ Failed to fetch URL (status ${res.status})`;
        }
        const contentType = res.headers.get("content-type") || "";
        const isTextLike =
          contentType.startsWith("text/") ||
          contentType.includes("application/json") ||
          contentType.includes("application/xml") ||
          contentType.includes("+json") ||
          contentType.includes("+xml");
        if (!isTextLike) {
          return `❌ Unsupported content-type for readTextFromUrl: ${contentType}`;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          const text = await res.text();
          return text;
        }
        const limit = maxBytes || 10 * 1024 * 1024;
        const chunks: Uint8Array[] = [];
        let downloaded = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            downloaded += value.byteLength;
            if (downloaded > limit) {
              return `❌ File exceeds maxBytes limit (${limit} bytes)`;
            }
            chunks.push(value);
          }
        }
        const buffer = Buffer.concat(chunks);
        return buffer.toString((charset as BufferEncoding) || "utf-8");
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return "⏱️ Timeout fetching the URL (15s).";
        }
        return `❌ Error fetching text: ${err?.message || String(err)}`;
      } finally {
        clearTimeout(timeout);
      }
    },
  }),

  parsePdfFromUrl: tool({
    description:
      "Download a PDF from a URL and extract its text content. Returns plain text.",
    inputSchema: z.object({
      url: z.string().url().describe("Publicly accessible URL to the PDF"),
      maxBytes: z
        .number()
        .min(1024)
        .max(25 * 1024 * 1024)
        .optional()
        .default(20 * 1024 * 1024)
        .describe("Maximum bytes to download (default 20MB, max 25MB)"),
    }),
    execute: async ({ url, maxBytes }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          return `❌ Failed to fetch URL (status ${res.status})`;
        }
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("pdf")) {
          return `❌ URL does not appear to be a PDF (content-type: ${contentType})`;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          const arrayBuffer = await res.arrayBuffer();
          // Use AI SDK for PDF processing instead of pdf-parse
          const { generateText } = await import("ai");
          const { openai } = await import("@ai-sdk/openai");

          try {
            const result = await generateText({
              model: openai("gpt-5"),
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "Extract all text content from this PDF file.",
                    },
                    {
                      type: "file",
                      data: Buffer.from(arrayBuffer),
                      mediaType: "application/pdf",
                      filename: "document.pdf",
                    },
                  ],
                },
              ],
            });
            return result.text || "";
          } catch (error) {
            return `❌ Error processing PDF with AI SDK: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
        const limit = maxBytes || 20 * 1024 * 1024;
        const chunks: Uint8Array[] = [];
        let downloaded = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            downloaded += value.byteLength;
            if (downloaded > limit) {
              return `❌ PDF exceeds maxBytes limit (${limit} bytes)`;
            }
            chunks.push(value);
          }
        }
        const buffer = Buffer.concat(chunks);

        // Use AI SDK for PDF processing instead of pdf-parse
        const { generateText } = await import("ai");
        const { openai } = await import("@ai-sdk/openai");

        try {
          const result = await generateText({
            model: openai("gpt-5"),
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Extract all text content from this PDF file.",
                  },
                  {
                    type: "file",
                    data: buffer,
                    mediaType: "application/pdf",
                    filename: "document.pdf",
                  },
                ],
              },
            ],
          });
          return result.text || "";
        } catch (error) {
          return `❌ Error processing PDF with AI SDK: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return "⏱️ Timeout fetching the PDF (20s).";
        }
        return `❌ Error parsing PDF: ${err?.message || String(err)}`;
      } finally {
        clearTimeout(timeout);
      }
    },
  }),

  parseDocxFromUrl: tool({
    description:
      "Download a DOCX from a URL and extract its text content using mammoth.",
    inputSchema: z.object({
      url: z.string().url().describe("Publicly accessible URL to the DOCX"),
      maxBytes: z
        .number()
        .min(1024)
        .max(25 * 1024 * 1024)
        .optional()
        .default(15 * 1024 * 1024)
        .describe("Maximum bytes to download (default 15MB, max 25MB)"),
    }),
    execute: async ({ url, maxBytes }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          return `❌ Failed to fetch URL (status ${res.status})`;
        }
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("word") && !contentType.includes("docx")) {
          // Allow even if header is missing; just warn
          // return `❌ URL does not appear to be a DOCX (content-type: ${contentType})`;
        }
        const reader = res.body?.getReader();
        const limit = maxBytes || 15 * 1024 * 1024;
        const chunks: Uint8Array[] = [];
        let downloaded = 0;
        if (reader) {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              downloaded += value.byteLength;
              if (downloaded > limit) {
                return `❌ DOCX exceeds maxBytes limit (${limit} bytes)`;
              }
              chunks.push(value);
            }
          }
        } else {
          const ab = await res.arrayBuffer();
          if (ab.byteLength > limit) {
            return `❌ DOCX exceeds maxBytes limit (${limit} bytes)`;
          }
          chunks.push(new Uint8Array(ab));
        }
        const buffer = Buffer.concat(chunks);
        const { value } = await mammoth.extractRawText({ buffer });
        return value || "";
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return "⏱️ Timeout fetching the DOCX (20s).";
        }
        return `❌ Error parsing DOCX: ${err?.message || String(err)}`;
      } finally {
        clearTimeout(timeout);
      }
    },
  }),
  // Chart Creation Tool - Create interactive charts for data visualization
  createChart: tool({
    description: `Create interactive charts for clinical and research data visualization. 
    
    CRITICAL: ALL FIVE FIELDS ARE REQUIRED:
    1. title - Chart title (e.g., "Drug Efficacy Comparison", "Patient Response Rates")
    2. type - Chart type: "line", "bar", or "area" 
    3. xAxisLabel - X-axis label (e.g., "Time (weeks)", "Treatment Group")
    4. yAxisLabel - Y-axis label (e.g., "Response Rate (%)", "Survival Probability")
    5. dataSeries - Array of data series with this exact format:
    
    Example complete tool call:
    {
      "title": "CAR-T vs Chemotherapy Response Rates",
      "type": "line",
      "xAxisLabel": "Weeks Since Treatment",
      "yAxisLabel": "Response Rate (%)",
      "dataSeries": [
        {
          "name": "CAR-T Therapy",
          "data": [
            {"x": "Week 0", "y": 0},
            {"x": "Week 4", "y": 65.5},
            {"x": "Week 8", "y": 78.2}
          ]
        },
        {
          "name": "Standard Chemotherapy",
          "data": [
            {"x": "Week 0", "y": 0},
            {"x": "Week 4", "y": 32.1},
            {"x": "Week 8", "y": 38.5}
          ]
        }
      ]
    }
    
    NEVER omit any of the five required fields. Each data point must have x (date/label) and y (numeric value).`,
    inputSchema: z.object({
      title: z
        .string()
        .describe('Chart title (e.g., "Apple vs Microsoft Stock Performance")'),
      type: z
        .enum(["line", "bar", "area"])
        .describe(
          'Chart type - use "line" for time series data like stock prices'
        ),
      xAxisLabel: z
        .string()
        .describe('X-axis label (e.g., "Date", "Quarter", "Year")'),
      yAxisLabel: z
        .string()
        .describe(
          'Y-axis label (e.g., "Price ($)", "Revenue (Millions)", "Percentage (%)")'
        ),
      dataSeries: z
        .array(
          z.object({
            name: z
              .string()
              .describe(
                'Series name - include company/ticker for stocks (e.g., "Apple (AAPL)", "Tesla Revenue")'
              ),
            data: z
              .array(
                z.object({
                  x: z
                    .union([z.string(), z.number()])
                    .describe(
                      'X-axis value - use date strings like "2024-01-01" for time series'
                    ),
                  y: z
                    .number()
                    .describe(
                      "Y-axis numeric value - stock price, revenue, percentage, etc."
                    ),
                })
              )
              .describe(
                "Array of data points with x (date/label) and y (value) properties"
              ),
          })
        )
        .describe(
          "REQUIRED: Array of data series - each series has name and data array with x,y objects"
        ),
      description: z
        .string()
        .optional()
        .describe("Optional description explaining what the chart shows"),
    }),
    execute: async ({
      title,
      type,
      xAxisLabel,
      yAxisLabel,
      dataSeries,
      description,
    }) => {
      // Track chart creation
      await track("Chart Created", {
        chartType: type,
        title: title,
        seriesCount: dataSeries.length,
        totalDataPoints: dataSeries.reduce(
          (sum, series) => sum + series.data.length,
          0
        ),
        hasDescription: !!description,
      });

      // Enhanced date parsing for multiple formats (same logic as FinancialChart)
      const parseDate = (dateStr: string | number): Date | null => {
        if (typeof dateStr === "number") return new Date(dateStr);

        // Try multiple date formats in order of preference
        const formats = [
          // ISO format (YYYY-MM-DD, YYYY-MM-DDTHH:mm:ss, etc.)
          (str: string) => {
            const date = new Date(str);
            return !isNaN(date.getTime()) ? date : null;
          },
          // YYYY-MM-DD format
          (str: string) => {
            const match = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
            if (match) {
              const [, year, month, day] = match;
              return new Date(
                parseInt(year),
                parseInt(month) - 1,
                parseInt(day)
              );
            }
            return null;
          },
          // DD/MM/YYYY format (common in European/international contexts)
          (str: string) => {
            const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (match) {
              const [, day, month, year] = match;
              const dayNum = parseInt(day);
              const monthNum = parseInt(month);
              const yearNum = parseInt(year);

              // Validate that day <= 31 and month <= 12 (basic validation)
              if (dayNum <= 31 && monthNum <= 12) {
                const parsedDate = new Date(yearNum, monthNum - 1, dayNum);
                // Additional validation: check if the parsed date components match
                if (
                  parsedDate.getDate() === dayNum &&
                  parsedDate.getMonth() === monthNum - 1
                ) {
                  return parsedDate;
                }
              }
            }
            return null;
          },
          // MM/DD/YYYY format (common in US contexts)
          (str: string) => {
            const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (match) {
              const [, month, day, year] = match;
              const monthNum = parseInt(month);
              const dayNum = parseInt(day);
              const yearNum = parseInt(year);

              // Validate that month <= 12 and day <= 31 (basic validation)
              if (monthNum <= 12 && dayNum <= 31) {
                const parsedDate = new Date(yearNum, monthNum - 1, dayNum);
                // Additional validation: check if the parsed date components match
                if (
                  parsedDate.getMonth() === monthNum - 1 &&
                  parsedDate.getDate() === dayNum
                ) {
                  return parsedDate;
                }
              }
            }
            return null;
          },
        ];

        for (const format of formats) {
          try {
            const date = format(dateStr);
            if (date && !isNaN(date.getTime())) {
              return date;
            }
          } catch (e) {
            // Continue to next format
          }
        }
        return null;
      };

      // Sort data series by x-axis values (dates) to ensure chronological order
      const sortedDataSeries = dataSeries.map((series) => ({
        ...series,
        data: [...series.data].sort((a, b) => {
          // Sort by x value (handles both strings and numbers)
          if (typeof a.x === "string" && typeof b.x === "string") {
            const dateA = parseDate(a.x);
            const dateB = parseDate(b.x);

            // If both are valid dates, sort chronologically (earliest first)
            if (dateA && dateB) {
              return dateA.getTime() - dateB.getTime();
            }

            // Fallback to string comparison for non-date strings
            return a.x.localeCompare(b.x);
          }
          return Number(a.x) - Number(b.x);
        }),
      }));

      // Log chart creation details
      // Return structured chart data for the UI to render
      const chartData = {
        chartType: type,
        title,
        xAxisLabel,
        yAxisLabel,
        dataSeries: sortedDataSeries,
        description,
        metadata: {
          totalSeries: dataSeries.length,
          totalDataPoints: dataSeries.reduce(
            (sum, series) => sum + series.data.length,
            0
          ),
          dateRange:
            sortedDataSeries.length > 0 && sortedDataSeries[0].data.length > 0
              ? {
                  start: sortedDataSeries[0].data[0].x,
                  end: sortedDataSeries[0].data[
                    sortedDataSeries[0].data.length - 1
                  ].x,
                }
              : null,
        },
      };

      return chartData;
    },
  }),

  codeExecution: tool({
    description: `Execute Python code securely in a Daytona Sandbox for financial modeling, data analysis, and calculations. 
    
    🚨 IMPORTANT: Keep your code concise so it runs reliably in the Daytona sandbox. Extremely large scripts can hit execution limits or time out, so break complex work into smaller runs when possible.
    
    CRITICAL: Always include print() statements to show results. Daytona can also capture rich artifacts (e.g., charts) when code renders images.

    REQUIRED FORMAT - Your Python code MUST include print statements:

    IMPORTANT INSTRUCTIONS:
    - CODE LENGTH: Aim to keep scripts reasonably small (≈15k characters or less). Very large programs may time out or fail to execute.
    - EXECUTION TIME: Each run has a hard ${
      DAYTONA_EXECUTION_TIMEOUT_MS / 1000
    }s wall-clock limit. Break long workflows into multiple runs.
    - Do not install or upgrade packages. Do not access the network.
    - If an import is missing, raise a clear error; do not attempt pip, subprocess calls to pip, or any downloader. Use only stdlib, NumPy, and pandas already present.
    - Array-safe numerics: Use NumPy for all array operations (np.exp, np.sqrt, np.log, etc.). Do not call math.* on arrays.
    - Normal CDF / p-values: Do not use SciPy or np.erf. Use a provided norm_cdf that works on scalars and arrays.
    - Shape discipline: All inputs must be strictly 1-D or 2-D. Before any linear algebra or broadcasting, assert shapes and length alignment (e.g., len(time) == len(event) == X.shape[0]). If a mismatch exists, raise a clear error immediately.
    - Determinism: Use np.random.default_rng(<fixed_seed>) for randomness.
    - I/O and side-effects: No background downloads; no writes outside /mnt/data. Keep console output concise and human-readable.
    - Stability: Standardize numeric features when appropriate; add small ridge terms (e.g., 1e-6) if matrices are near-singular; avoid holding giant (n,p,p) tensors unless necessary.
    - Clarity on failure: If any step cannot be satisfied under these rules, stop and print a single clear reason (do not auto-retry with different libraries or shapes).
    - KEEP CODE SHORT: Break complex tasks into smaller pieces or simplify. Staying concise avoids sandbox timeouts.
    
    Example for financial calculations:
    # Calculate compound interest
    principal = 10000
    rate = 0.07
    time = 5
    amount = principal * (1 + rate) ** time
    print(f"Initial investment: $\{principal:,.2f}")
    print(f"Annual interest rate: \{rate*100:.1f}%")
    print(f"Time period: \{time} years")
    print(f"Final amount: $\{amount:,.2f}")
    print(f"Interest earned: $\{amount - principal:,.2f}")
    
    Example for data analysis:
    import math
    values = [100, 150, 200, 175, 225]
    average = sum(values) / len(values)
    std_dev = math.sqrt(sum((x - average) ** 2 for x in values) / len(values))
    print(f"Data: \{values}")
    print(f"Average: \{average:.2f}")
    print(f"Standard deviation: \{std_dev:.2f}")
    
    IMPORTANT: 
    - Always end with print() statements showing final results
    - Use descriptive labels and proper formatting
    - Include units, currency symbols, or percentages where appropriate
    - Show intermediate steps for complex calculations`,
    inputSchema: z.object({
      code: z
        .string()
        .describe(
          "Python code to execute - MUST include print() statements to display results. Use descriptive output formatting with labels, units, and proper number formatting. Keep code concise for reliable execution."
        ),
      description: z
        .string()
        .optional()
        .describe(
          'Brief description of what the calculation or analysis does (e.g., "Calculate future value with compound interest", "Analyze portfolio risk metrics")'
        ),
    }),
    execute: async ({ code, description }, options) => {
      const userId = (options as any)?.experimental_context?.userId;
      const sessionId = (options as any)?.experimental_context?.sessionId;
      const userTier = (options as any)?.experimental_context?.userTier;
      const isDevelopment = process.env.NEXT_PUBLIC_APP_MODE === "development";

      const startTime = Date.now();

      try {
        // Initialize Daytona client
        const daytonaApiKey = process.env.DAYTONA_API_KEY;
        if (!daytonaApiKey) {
          return "❌ **Configuration Error**: Daytona API key is not configured. Please set DAYTONA_API_KEY in your environment.";
        }

        const daytona = new Daytona({
          apiKey: daytonaApiKey,
          // Optional overrides if provided
          serverUrl: process.env.DAYTONA_API_URL,
          target: (process.env.DAYTONA_TARGET as any) || undefined,
        });

        let sandbox: any | null = null;
        let timeoutHandle: NodeJS.Timeout | null = null;

        try {
          // Create a Python sandbox
          sandbox = await daytona.create({ language: "python" });

          // Execute the user's code
          const executionPromise = sandbox.process.codeRun(code);
          const execution = (await Promise.race([
            executionPromise,
            new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(
                  new Error(
                    `Execution timeout after ${DAYTONA_EXECUTION_TIMEOUT_MS}ms. Please simplify your code or break it into smaller pieces.`
                  )
                );
              }, DAYTONA_EXECUTION_TIMEOUT_MS);
            }),
          ])) as Awaited<typeof executionPromise>;
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }

          const executionTime = Date.now() - startTime;

          // Track code execution
          await track("Python Code Executed", {
            success: execution.exitCode === 0,
            codeLength: code.length,
            outputLength: execution.result?.length || 0,
            executionTime: executionTime,
            hasDescription: !!description,
            hasError: execution.exitCode !== 0,
            hasArtifacts: !!execution.artifacts,
          });

          // Track usage for pay-per-use customers with Polar events
          if (
            userId &&
            sessionId &&
            userTier === "pay_per_use" &&
            execution.exitCode === 0 &&
            !isDevelopment
          ) {
            try {
              const polarTracker = new PolarEventTracker();

              await polarTracker.trackDaytonaUsage(
                userId,
                sessionId,
                executionTime,
                {
                  codeLength: code.length,
                  hasArtifacts: !!execution.artifacts,
                  success: execution.exitCode === 0,
                  description: description || "Code execution",
                }
              );
            } catch (error) {
              console.error(
                "[CodeExecution] Failed to track Daytona usage:",
                error
              );
              // Don't fail the tool execution if usage tracking fails
            }
          }

          // Handle execution errors
          if (execution.exitCode !== 0) {
            // Provide helpful error messages for common issues
            let helpfulError = execution.result || "Unknown execution error";
            if (helpfulError.includes("NameError")) {
              helpfulError = `${helpfulError}\n\n💡 **Tip**: Make sure all variables are defined before use. If you're trying to calculate something, include the full calculation in your code.`;
            } else if (helpfulError.includes("SyntaxError")) {
              helpfulError = `${helpfulError}\n\n💡 **Tip**: Check your Python syntax. Make sure all parentheses, quotes, and indentation are correct.`;
            } else if (helpfulError.includes("ModuleNotFoundError")) {
              helpfulError = `${helpfulError}\n\n💡 **Tip**: You can install packages inside the Daytona sandbox using pip if needed (e.g., pip install numpy).`;
            }

            return `❌ **Execution Error**: ${helpfulError}`;
          }

          // Format the successful execution result
          return `🐍 **Python Code Execution (Daytona Sandbox)**
${description ? `**Description**: ${description}\n` : ""}

\`\`\`python
${code}
\`\`\`

**Output:**
\`\`\`
${execution.result || "(No output produced)"}
\`\`\`

⏱️ **Execution Time**: ${executionTime}ms`;
        } catch (error: any) {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          console.error("[CodeExecution] Error:", error);

          const isTimeout =
            typeof error?.message === "string" &&
            error.message.includes("Execution timeout");

          if (isTimeout) {
            return `⌛ **Timeout**: The Python sandbox stopped after ${
              DAYTONA_EXECUTION_TIMEOUT_MS / 1000
            } seconds. Break the task into smaller steps or reduce the size of the script before retrying.`;
          }

          return `❌ **Error**: Failed to execute Python code. ${
            error?.message || "Unknown error occurred"
          }`;
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          // Clean up sandbox
          try {
            if (sandbox) {
              if (typeof sandbox.stop === "function") {
                await sandbox.stop().catch(() => {});
              }
              await sandbox.delete();
            }
          } catch (cleanupError) {
            console.error(
              "[CodeExecution] Failed to delete Daytona sandbox:",
              cleanupError
            );
          }
        }
      } catch (error: any) {
        console.error("[CodeExecution] Error:", error);

        return `❌ **Error**: Failed to execute Python code. ${
          error.message || "Unknown error occurred"
        }`;
      }
    },
  }),

  economicsSearch: tool({
    description:
      "Search for comprehensive economics data including macroeconomic indicators, market trends, regulatory updates, company filings, and financial news using the Valyu DeepSearch API",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'Economics search query (e.g., "Apple latest quarterly earnings", "Bitcoin price trends", "Tesla SEC filings")'
        ),
      dataType: z
        .enum([
          "economic_indicators",
          "economic_research",
          "economic_news",
          "economic_policy",
          "economic_history",
          "economic_comparative",
        ])
        .optional()
        .describe("Type of economics data to focus on"),
      maxResults: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .default(10)
        .describe(
          "Maximum number of results to return. This is not number of daya/hours of stock data, for example 1 yr of stock data for 1 company is 1 result"
        ),
    }),
    execute: async ({ query, dataType, maxResults }, options) => {
      const userId = (options as any)?.experimental_context?.userId;
      const sessionId = (options as any)?.experimental_context?.sessionId;
      const userTier = (options as any)?.experimental_context?.userTier;
      const isDevelopment = process.env.NEXT_PUBLIC_APP_MODE === "development";

      const apiKey = process.env.VALYU_API_KEY;
      if (!apiKey) {
        return "❌ Valyu API key not configured. Please add VALYU_API_KEY to your environment variables to enable economics search.";
      }
      const valyu = new Valyu(apiKey, "https://api.valyu.network/v1");

      const searchOptions: any = {
        maxNumResults: maxResults || 10,
      };

      let fetchError: unknown = null;
      const response = await callValyuWithTimeout(
        valyu,
        query,
        searchOptions,
        30000,
        2
      ).catch((error: unknown) => {
        fetchError = error;
        return null;
      });

      if (!response) {
        if (fetchError instanceof Error) {
          if (
            fetchError.message.includes("401") ||
            fetchError.message.includes("unauthorized")
          ) {
            return "🔐 Invalid Valyu API key. Please check your VALYU_API_KEY environment variable for economics search.";
          }
          if (fetchError.message.includes("429")) {
            return "⏱️ Rate limit exceeded. Please try again in a moment.";
          }
          if (
            fetchError.message.includes("network") ||
            fetchError.message.includes("fetch")
          ) {
            return "🌐 Network error connecting to Valyu API. Please check your internet connection.";
          }
          return `❌ Error searching economics data: ${fetchError.message}`;
        }
        return "❌ Error searching economics data: Unknown error";
      }

      await track("Valyu API Call", {
        toolType: "economicsSearch",
        query: query,
        dataType: dataType || "auto",
        maxResults: maxResults || 10,
        resultCount: response?.results?.length || 0,
        hasApiKey: !!apiKey,
        cost: (response as any)?.total_deduction_dollars || null,
        txId: (response as any)?.tx_id || null,
      });

      if (userId && sessionId && userTier === "pay_per_use" && !isDevelopment) {
        const polarTracker = new PolarEventTracker();
        const valyuCostDollars =
          (response as any)?.total_deduction_dollars || 0;

        await polarTracker
          .trackValyuAPIUsage(
            userId,
            sessionId,
            "economicsSearch",
            valyuCostDollars,
            {
              query,
              resultCount: response?.results?.length || 0,
              dataType: dataType || "auto",
              success: true,
              tx_id: (response as any)?.tx_id,
            }
          )
          .catch((error: unknown) => {
            console.error(
              "[EconomicsSearch] Failed to track Valyu API usage:",
              error
            );
          });
      }

      if (!response.results || response.results.length === 0) {
        return `🔍 No economics data found for "${query}". Try rephrasing your search or checking if the company/symbol exists.`;
      }

      const formattedResponse = {
        type: "economics_search",
        query: query,
        dataType: dataType,
        resultCount: response.results.length,
        results: response.results.map((result: any) => ({
          title: result.title || "Financial Data",
          url: result.url,
          content: result.content,
          date: result.metadata?.date,
          source: result.metadata?.source,
          dataType: result.data_type,
          length: result.length,
          image_url: result.image_url || {},
          relevance_score: result.relevance_score,
        })),
      };

      return JSON.stringify(formattedResponse, null, 2);
    },
  }),
  getFREDSeriesData: tool({
    description:
      "Get full detailed information about a specific FRED (Federal Reserve Economic Data) time series using a search query. Use this to find and retrieve FRED economic data.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Search query for FRED (Federal Reserve Economic Data) - e.g., 'GDP', 'unemployment rate', 'inflation'"
        ),
      maxResults: z
        .number()
        .min(1)
        .max(5)
        .optional()
        .default(10)
        .describe("Maximum number of results to return"),
    }),
    execute: async ({ query, maxResults }, options) => {
      const userId = (options as any)?.experimental_context?.userId;
      const sessionId = (options as any)?.experimental_context?.sessionId;
      const userTier = (options as any)?.experimental_context?.userTier;
      const isDevelopment = process.env.NEXT_PUBLIC_APP_MODE === "development";
      const requestId = (options as any)?.experimental_context?.requestId;

      try {
        const apiKey = process.env.VALYU_API_KEY;
        if (!apiKey) {
          return "❌ Valyu API key not configured. Please add VALYU_API_KEY to your environment variables.";
        }
        const valyu = new Valyu(apiKey, "https://api.valyu.network/v1");

        // Search for the specific FRED Series ID
        const searchOptions: any = {
          maxNumResults: 5,
          searchType: "proprietary",
          includedSources: ["valyu/valyu-fred"],
          relevanceThreshold: 0.1, // Lower threshold since we're looking for exact match
          isToolCall: true,
        };
        if (searchOptions.includedSources?.sort)
          searchOptions.includedSources.sort();

        const sessionKey = buildToolKey(
          "getFREDSeriesData",
          query,
          searchOptions
        );
        const response = await withSessionMemo(sessionId, sessionKey, () =>
          once(
            "getFREDSeriesData",
            canonQuery(query),
            canonOptions(searchOptions),
            () =>
              callValyuWithTimeout(
                valyu,
                `FRED series: ${query}`,
                searchOptions,
                30000, // 30 second timeout
                2 // 2 retries
              )
          )
        );

        const mapped = response.results.map((r: any) => {
          const key = r.fred_id || r.metadata?.fred_id;
          return {
            id: key ? keyToUuid(key) : resultId(r),
            title: r.title,
            url: r.url,
            content: r.content,
            date: r.metadata?.date,
            source: r.metadata?.source || r.source,
          };
        });

        const unique = dedupeBy(mapped, (x: any) => x.id);
        const final = dedupeAgainstRequest(requestId, unique, (x: any) => x.id);
        logDedupe(
          "getFREDSeriesData",
          requestId,
          response?.results?.length || 0,
          mapped.length,
          unique.length,
          final
        );

        await track("Valyu API Call", {
          toolType: "getFREDSeriesData",
          query,
          resultCount: response?.results?.length || 0,
          hasApiKey: !!apiKey,
          cost: (response as any)?.total_deduction_dollars ?? null,
          txId: (response as any)?.tx_id ?? null,
        });

        if (
          userId &&
          sessionId &&
          userTier === "pay_per_use" &&
          !isDevelopment
        ) {
          try {
            const polarTracker = new PolarEventTracker();
            const valyuCostDollars =
              (response as any)?.total_deduction_dollars ?? 0;
            await polarTracker.trackValyuAPIUsage(
              userId,
              sessionId,
              "getFREDSeriesData",
              valyuCostDollars,
              {
                query,
                resultCount: response?.results?.length || 0,
                success: true,
                tx_id: (response as any)?.tx_id,
              }
            );
          } catch (error) {
            console.error(
              "[getFREDSeriesData] Failed to track Valyu API usage:",
              error
            );
          }
        }

        if (!response || !response.results || response.results.length === 0) {
          return JSON.stringify(
            {
              type: "FRED_series_details",
              query,
              found: false,
              message: `No FRED series found for query: ${query}`,
            },
            null,
            2
          );
        }

        // Parse the full trial data
        const result = response.results[0];
        const trialData = parseApiContent(result.content);

        // Return the full parsed trial data
        const formattedResponse = {
          type: "FRED_series_details",
          query,
          found: true,
          title: result.title,
          url: result.url,
          data: trialData, // Full trial data
          note: `Full details for FRED series ${query}`,
        };

        return JSON.stringify(formattedResponse, null, 2);
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message?.includes("401") ||
            error.message?.includes("unauthorized")
          ) {
            return "🔐 Invalid Valyu API key. Please check your VALYU_API_KEY environment variable.";
          }
        }
        return `❌ Error fetching FRED series details: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
      }
    },
  }),

  getBLSSeriesData: tool({
    description:
      "Get full detailed information about a specific BLS (Bureau of Labor Statistics) time series using a search query. Use this to find and retrieve BLS economic data.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Search query for BLS (Bureau of Labor Statistics) - e.g., 'unemployment', 'employment', 'labor force'"
        ),
      maxResults: z
        .number()
        .min(1)
        .max(5)
        .optional()
        .default(10)
        .describe("Maximum number of results to return"),
    }),
    execute: async ({ query, maxResults }, options) => {
      const userId = (options as any)?.experimental_context?.userId;
      const sessionId = (options as any)?.experimental_context?.sessionId;
      const userTier = (options as any)?.experimental_context?.userTier;
      const isDevelopment = process.env.NEXT_PUBLIC_APP_MODE === "development";
      const requestId = (options as any)?.experimental_context?.requestId;

      try {
        const apiKey = process.env.VALYU_API_KEY;
        if (!apiKey) {
          return "❌ Valyu API key not configured. Please add VALYU_API_KEY to your environment variables.";
        }
        const valyu = new Valyu(apiKey, "https://api.valyu.network/v1");

        // Search for the specific FRED Series ID
        const searchOptions: any = {
          maxNumResults: 5,
          searchType: "proprietary",
          includedSources: ["valyu/valyu-bls"],
          relevanceThreshold: 0.1, // Lower threshold since we're looking for exact match
          isToolCall: true,
        };
        if (searchOptions.includedSources?.sort)
          searchOptions.includedSources.sort();

        const sessionKey = buildToolKey(
          "getBLSSeriesData",
          query,
          searchOptions
        );
        const response = await withSessionMemo(sessionId, sessionKey, () =>
          once(
            "getBLSSeriesData",
            canonQuery(query),
            canonOptions(searchOptions),
            () =>
              callValyuWithTimeout(
                valyu,
                `BLS series: ${query}`,
                searchOptions,
                30000, // 30 second timeout
                2 // 2 retries
              )
          )
        );

        const mapped = response.results.map((r: any) => {
          const key = r.bls_id || r.metadata?.bls_id;
          return {
            id: key ? keyToUuid(key) : resultId(r),
            title: r.title,
            url: r.url,
            content: r.content,
            date: r.metadata?.date,
            source: r.metadata?.source || r.source,
          };
        });

        const unique = dedupeBy(mapped, (x: any) => x.id);
        const final = dedupeAgainstRequest(requestId, unique, (x: any) => x.id);
        logDedupe(
          "getBLSSeriesData",
          requestId,
          response?.results?.length || 0,
          mapped.length,
          unique.length,
          final
        );

        await track("Valyu API Call", {
          toolType: "getBLSSeriesData",
          query: query,
          resultCount: response?.results?.length || 0,
          hasApiKey: !!apiKey,
          cost: (response as any)?.total_deduction_dollars || null,
          txId: (response as any)?.tx_id || null,
        });

        if (
          userId &&
          sessionId &&
          userTier === "pay_per_use" &&
          !isDevelopment
        ) {
          try {
            const polarTracker = new PolarEventTracker();
            const valyuCostDollars =
              (response as any)?.total_deduction_dollars || 0;
            await polarTracker.trackValyuAPIUsage(
              userId,
              sessionId,
              "getBLSSeriesData",
              valyuCostDollars,
              {
                query,
                resultCount: response?.results?.length || 0,
                success: true,
                tx_id: (response as any)?.tx_id,
              }
            );
          } catch (error) {
            console.error(
              "[getBLSSeriesData] Failed to track Valyu API usage:",
              error
            );
          }
        }

        if (!response || !response.results || response.results.length === 0) {
          return JSON.stringify(
            {
              type: "BLS_series_details",
              query: query,
              found: false,
              message: `No BLS series found with: ${query}`,
            },
            null,
            2
          );
        }

        // Parse the full trial data
        const result = response.results[0];
        const trialData = parseApiContent(result.content);

        // Return the full parsed trial data
        const formattedResponse = {
          type: "BLS_series_details",
          query: query,
          found: true,
          title: result.title,
          url: result.url,
          data: trialData, // Full trial data
          note: `Full details for BLS series ${query}`,
        };

        return JSON.stringify(formattedResponse, null, 2);
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message.includes("401") ||
            error.message.includes("unauthorized")
          ) {
            return "🔐 Invalid Valyu API key. Please check your VALYU_API_KEY environment variable.";
          }
        }
        return `❌ Error fetching BLS series details: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
      }
    },
  }),

  getWBDetails: tool({
    description:
      "Search for World Bank economic indicator metadata and descriptions. This tool finds information about indicators but does NOT fetch actual time series data. For time series data, use other tools like getFREDSeriesData or webSearch to find World Bank data sources.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Search query for World Bank economic indicator metadata and descriptions"
        ),
      maxResults: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .default(10)
        .describe("Maximum number of results to return"),
    }),
    execute: async ({ query, maxResults }, options) => {
      const userId = (options as any)?.experimental_context?.userId;
      const sessionId = (options as any)?.experimental_context?.sessionId;
      const userTier = (options as any)?.experimental_context?.userTier;
      const isDevelopment = process.env.NEXT_PUBLIC_APP_MODE === "development";

      try {
        // Check if Valyu API key is available
        const apiKey = process.env.VALYU_API_KEY;
        if (!apiKey) {
          return "❌ Valyu API key not configured. Please add VALYU_API_KEY to your environment variables to enable World Bank search.";
        }
        const valyu = new Valyu(apiKey, "https://api.valyu.network/v1");

        // Configure search options for Wiley sources
        const searchOptions: any = {
          maxNumResults: maxResults || 10,
          searchType: "proprietary",
          includedSources: ["valyu/valyu-worldbank-indicators"],
        };

        // Add timeout configuration to prevent hanging
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

        let response;
        try {
          response = await valyu.search(query, searchOptions);
          clearTimeout(timeoutId);
        } catch (error: any) {
          clearTimeout(timeoutId);
          if (error.name === "AbortError") {
            throw new Error(
              "Valyu API request timed out after 30 seconds. The API might be slow or unresponsive."
            );
          }
          throw error;
        }

        // Track Valyu Wiley search call
        await track("Valyu API Call", {
          toolType: "WorldBankSearch",
          query: query,
          maxResults: maxResults || 10,
          resultCount: response?.results?.length || 0,
          hasApiKey: !!apiKey,
          cost: (response as any)?.total_deduction_dollars || null,
          txId: (response as any)?.tx_id || null,
        });

        // Track usage for pay-per-use customers with Polar events
        if (
          userId &&
          sessionId &&
          userTier === "pay_per_use" &&
          !isDevelopment
        ) {
          try {
            const polarTracker = new PolarEventTracker();
            const valyuCostDollars =
              (response as any)?.total_deduction_dollars || 0;
            await polarTracker.trackValyuAPIUsage(
              userId,
              sessionId,
              "WorldBankSearch",
              valyuCostDollars,
              {
                query,
                resultCount: response?.results?.length || 0,
                success: true,
                tx_id: (response as any)?.tx_id,
              }
            );
          } catch (error) {
            console.error(
              "[WorldBankSearch] Failed to track Valyu API usage:",
              error
            );
            // Don't fail the search if usage tracking fails
          }
        }

        if (!response || !response.results || response.results.length === 0) {
          return JSON.stringify(
            {
              type: "WB_series_details",
              query: query,
              found: false,
              message: `No World Bank economic indicator metadata found for "${query}". This tool only searches for indicator descriptions, not time series data. Try rephrasing your search or use other tools for actual data.`,
            },
            null,
            2
          );
        }

        // Return the first result in the expected format for the chat interface
        const firstResult = response.results[0];

        // Truncate very large content to prevent processing issues
        let content = firstResult.content;
        const maxContentLength = 50000; // 50KB limit
        if (content && content.length > maxContentLength) {
          content =
            content.substring(0, maxContentLength) +
            "\n\n... (content truncated due to size)";
        }

        // Also truncate the data field to prevent massive JSON responses
        let data = firstResult;
        if (data && JSON.stringify(data).length > 20000) {
          data = {
            ...firstResult,
            content: "Data available but truncated due to size",
            originalSize: JSON.stringify(firstResult).length,
          } as any;
        }

        const formattedResponse = {
          type: "WB_series_details",
          query: query,
          found: true,
          title: firstResult.title || "World Bank Economic Indicator",
          url: firstResult.url,
          content: content,
          data: data,
          note: `World Bank indicator metadata for ${query}. This is descriptive information about the indicator, not actual time series data.`,
        };

        try {
          return JSON.stringify(formattedResponse, null, 2);
        } catch (stringifyError) {
          console.error(
            "[WorldBank Search] JSON stringify failed:",
            stringifyError
          );
          // Return a simplified version if stringify fails
          return JSON.stringify(
            {
              type: "WB_series_details",
              query: query,
              found: true,
              title: firstResult.title || "World Bank Economic Indicator",
              url: firstResult.url,
              content: "Data retrieved but too large to display fully",
              note: `World Bank data for ${query} (truncated due to size)`,
            },
            null,
            2
          );
        }
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message.includes("401") ||
            error.message.includes("unauthorized")
          ) {
            return "🔐 Invalid Valyu API key. Please check your VALYU_API_KEY environment variable.";
          }
          if (error.message.includes("429")) {
            return "⏱️ Rate limit exceeded. Please try again in a moment.";
          }
          if (
            error.message.includes("network") ||
            error.message.includes("fetch")
          ) {
            return "🌐 Network error connecting to Valyu API. Please check your internet connection.";
          }
        }

        return `❌ Error searching World Bank economic indicator metadata: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
      }
    },
  }),

  getUSASpendingDetails: tool({
    description:
      "Search for authoritative federal spending award details using a search query. Use this to find and retrieve USA Spending data.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Search query for USA Spending - e.g., 'defense contracts', 'healthcare spending', 'education grants'"
        ),
      maxResults: z
        .number()
        .min(1)
        .max(5)
        .optional()
        .default(10)
        .describe("Maximum number of results to return"),
    }),
    execute: async ({ query, maxResults }, options) => {
      const userId = (options as any)?.experimental_context?.userId;
      const sessionId = (options as any)?.experimental_context?.sessionId;
      const userTier = (options as any)?.experimental_context?.userTier;
      const isDevelopment = process.env.NEXT_PUBLIC_APP_MODE === "development";
      const requestId = (options as any)?.experimental_context?.requestId;

      try {
        const apiKey = process.env.VALYU_API_KEY;
        if (!apiKey) {
          return "❌ Valyu API key not configured. Please add VALYU_API_KEY to your environment variables.";
        }
        const valyu = new Valyu(apiKey, "https://api.valyu.network/v1");

        // Search for the specific FRED Series ID
        const searchOptions: any = {
          maxNumResults: maxResults,
          searchType: "proprietary",
          includedSources: ["valyu/valyu-usaspending"],
          relevanceThreshold: 0.1, // Lower threshold since we're looking for exact match
          isToolCall: true,
        };
        if (searchOptions.includedSources?.sort)
          searchOptions.includedSources.sort();

        const sessionKey = buildToolKey(
          "getUSASpendingDetails",
          query,
          searchOptions
        );
        const response = await withSessionMemo(sessionId, sessionKey, () =>
          once(
            "getUSASpendingDetails",
            canonQuery(query),
            canonOptions(searchOptions),
            () =>
              callValyuWithTimeout(
                valyu,
                `USASpending.gov Award: ${query}`,
                searchOptions,
                30000, // 30 second timeout
                2 // 2 retries
              )
          )
        );

        const mapped = response.results.map((r: any) => {
          const key = r.usaspending_id || r.metadata?.usaspending_id;
          return {
            id: key ? keyToUuid(key) : resultId(r),
            title: r.title,
            url: r.url,
            content: r.content,
            date: r.metadata?.date,
            source: r.metadata?.source || r.source,
          };
        });

        const unique = dedupeBy(mapped, (x: any) => x.id);
        const final = dedupeAgainstRequest(requestId, unique, (x: any) => x.id);
        logDedupe(
          "getUSASpendingDetails",
          requestId,
          response?.results?.length || 0,
          mapped.length,
          unique.length,
          final
        );

        await track("Valyu API Call", {
          toolType: "getUSASpendingDetails",
          query: query,
          resultCount: response?.results?.length || 0,
          hasApiKey: !!apiKey,
          cost: (response as any)?.total_deduction_dollars || null,
          txId: (response as any)?.tx_id || null,
        });

        if (
          userId &&
          sessionId &&
          userTier === "pay_per_use" &&
          !isDevelopment
        ) {
          try {
            const polarTracker = new PolarEventTracker();
            const valyuCostDollars =
              (response as any)?.total_deduction_dollars || 0;
            await polarTracker.trackValyuAPIUsage(
              userId,
              sessionId,
              "getUSASpendingDetails",
              valyuCostDollars,
              {
                query,
                resultCount: response?.results?.length || 0,
                success: true,
                tx_id: (response as any)?.tx_id,
              }
            );
          } catch (error) {
            console.error(
              "[getUSASpendingDetails] Failed to track Valyu API usage:",
              error
            );
          }
        }

        if (!response || !response.results || response.results.length === 0) {
          return JSON.stringify(
            {
              type: "USASpending_series_details",
              query: query,
              found: false,
              message: `No USASpending series found with USASpending ID: ${query}`,
            },
            null,
            2
          );
        }

        // Parse the full trial data
        const result = response.results[0];
        const trialData = parseApiContent(result.content);

        // Return the full parsed trial data
        const formattedResponse = {
          type: "USASpending_series_details",
          query: query,
          found: true,
          title: result.title,
          url: result.url,
          data: trialData, // Full trial data
          note: `Full details for USASpending series ${query}`,
        };

        return JSON.stringify(formattedResponse, null, 2);
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message.includes("401") ||
            error.message.includes("unauthorized")
          ) {
            return "🔐 Invalid Valyu API key. Please check your VALYU_API_KEY environment variable.";
          }
        }
        return `❌ Error fetching USASpending series details: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
      }
    },
  }),

  webSearch: tool({
    description:
      "Search the web for general information on any topic using Valyu DeepSearch API with access to both proprietary sources and web content",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'Search query for any topic (e.g., "benefits of renewable energy", "latest AI developments", "climate change solutions")'
        ),
    }),
    execute: async ({ query }, options) => {
      const userId = (options as any)?.experimental_context?.userId;
      const sessionId = (options as any)?.experimental_context?.sessionId;
      const userTier = (options as any)?.experimental_context?.userTier;
      const isDevelopment = process.env.NEXT_PUBLIC_APP_MODE === "development";
      const requestId = (options as any)?.experimental_context?.requestId;

      try {
        // Initialize Valyu client (uses default/free tier if no API key)
        const valyu = new Valyu(
          process.env.VALYU_API_KEY,
          "https://api.valyu.network/v1"
        );

        // Configure search options
        const searchOptions = {
          searchType: "all" as const, // Search both proprietary and web sources
        };

        // Use per-session memo + in-flight dedupe
        const sessionKey = buildToolKey("webSearch", query, searchOptions);
        const response = await withSessionMemo(sessionId, sessionKey, () =>
          once(
            "webSearch",
            canonQuery(query),
            canonOptions(searchOptions),
            () =>
              callValyuWithTimeout(
                valyu,
                query,
                searchOptions,
                30000, // 30 second timeout
                2 // 2 retries
              )
          )
        );

        // Attach canonical id (DOI -> arXiv -> URL) mapped to deterministic UUIDs
        const mapped = (response?.results || []).map((r: any) => {
          const doi =
            extractDoi(r.url) ||
            extractDoi(typeof r.content === "string" ? r.content : "");
          const arxiv = extractArxivId(r.url);
          const normalized = normalizeUrl(r.url);
          const key = doi || arxiv || normalized;
          return {
            id: key ? keyToUuid(key) : resultId(r),
            title: r.title || "Web Result",
            url: r.url,
            content: r.content,
            date: r.metadata?.date,
            source: r.metadata?.source,
            dataType: r.data_type,
            length: r.length,
            image_url: r.image_url || {},
            relevance_score: r.relevance_score,
          };
        });

        const unique = dedupeBy(mapped, (x: any) => x.id);
        const final = dedupeAgainstRequest(requestId, unique, (x: any) => x.id);

        // Track Valyu web search call
        await track("Valyu API Call", {
          toolType: "webSearch",
          query: query,
          maxResults: 10,
          resultCount: final.length || 0,
          hasApiKey: !!process.env.VALYU_API_KEY,
          cost:
            (response as any)?.metadata?.totalCost ||
            (response as any)?.total_deduction_dollars ||
            null,
          searchTime: (response as any)?.metadata?.searchTime || null,
          txId: (response as any)?.tx_id || null,
        });

        // Track usage for pay-per-use customers with Polar events
        if (
          userId &&
          sessionId &&
          userTier === "pay_per_use" &&
          !isDevelopment
        ) {
          try {
            const polarTracker = new PolarEventTracker();
            // Use the actual Valyu API cost from response
            const valyuCostDollars =
              (response as any)?.total_deduction_dollars || 0;

            await polarTracker.trackValyuAPIUsage(
              userId,
              sessionId,
              "webSearch",
              valyuCostDollars,
              {
                query,
                resultCount: response?.results?.length || 0,
                success: true,
                tx_id: (response as any)?.tx_id,
                search_time: (response as any)?.metadata?.searchTime,
              }
            );
          } catch (error) {
            console.error(
              "[WebSearch] Failed to track Valyu API usage:",
              error
            );
            // Don't fail the search if usage tracking fails
          }
        }

        // Log the full API response for debugging
        if (
          !response ||
          !response.results ||
          response.results.length === 0 ||
          final.length === 0
        ) {
          return JSON.stringify(
            {
              type: "web_search",
              query: query,
              resultCount: 0,
              results: [],
              message: `No web results found for "${query}". Try rephrasing your search with different keywords.`,
            },
            null,
            2
          );
        }

        // Log key information about the search
        const metadata = (response as any).metadata;
        // Return structured data for the model to process
        const formattedResponse = {
          type: "web_search",
          query: query,
          resultCount: final.length,
          metadata: {
            totalCost: metadata?.totalCost,
            searchTime: metadata?.searchTime,
          },
          results: final.map((result: any) => ({
            id: result.id,
            title: result.title || "Web Result",
            url: result.url,
            content: result.content,
            date: result.date,
            source: result.source,
            dataType: result.dataType,
            length: result.length,
            image_url: result.image_url || {},
            relevance_score: result.relevance_score,
          })),
        };

        return JSON.stringify(formattedResponse, null, 2);
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message.includes("401") ||
            error.message.includes("unauthorized")
          ) {
            return "🔐 Authentication error with Valyu API. Please check your configuration.";
          }
          if (error.message.includes("429")) {
            return "⏱️ Rate limit exceeded. Please try again in a moment.";
          }
          if (
            error.message.includes("network") ||
            error.message.includes("fetch")
          ) {
            return "🌐 Network error connecting to Valyu API. Please check your internet connection.";
          }
          if (
            error.message.includes("price") ||
            error.message.includes("cost")
          ) {
            return "💰 Search cost exceeded maximum budget. Try reducing maxPrice or using more specific queries.";
          }
        }

        return `❌ Error performing web search: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
      }
    },
  }),
};

(economicsTools as Record<string, any>).financialSearch =
  economicsTools.economicsSearch;

// Export with both names for compatibility
export const financeTools = economicsTools;
