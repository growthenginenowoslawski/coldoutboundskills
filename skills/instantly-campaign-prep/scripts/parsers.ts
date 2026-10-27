// Minimal CSV + YAML parsers (Node built-ins only). Copied from
// skills/smartlead-campaign-upload-public/scripts/upload.ts so this skill is self-contained.
// Supported YAML subset: nested maps, lists of maps, scalars, [a,b] arrays. No anchors, block scalars or {} maps.

// ---------- CSV parsing ----------

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const cols = parseCsvLine(l);
    const r: Record<string, string> = {};
    headers.forEach((h, i) => (r[h] = (cols[i] ?? "").trim()));
    return r;
  });
  return { headers, rows };
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

export function parseYaml(text: string): YamlValue {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Strip comments (but not inside quoted strings — simple heuristic)
  const cleaned: { indent: number; content: string }[] = [];
  for (const raw of lines) {
    let line = raw;
    // strip trailing comment if not inside quotes
    let inQuote: string | null = null;
    let commentAt = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === inQuote && line[i - 1] !== "\\") inQuote = null;
      } else {
        if (c === '"' || c === "'") inQuote = c;
        else if (c === "#") { commentAt = i; break; }
      }
    }
    if (commentAt >= 0) line = line.slice(0, commentAt);
    const trimmedRight = line.replace(/\s+$/, "");
    if (!trimmedRight.trim()) continue;
    const indent = trimmedRight.search(/\S/);
    cleaned.push({ indent, content: trimmedRight.slice(indent) });
  }

  let idx = 0;
  function parseBlock(parentIndent: number): YamlValue {
    if (idx >= cleaned.length) return null;
    const firstIndent = cleaned[idx].indent;
    if (firstIndent <= parentIndent) return null;
    // detect list vs map
    if (cleaned[idx].content.startsWith("- ")) return parseList(firstIndent);
    return parseMap(firstIndent);
  }

  function parseMap(indent: number): Record<string, YamlValue> {
    const obj: Record<string, YamlValue> = {};
    while (idx < cleaned.length) {
      const line = cleaned[idx];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new Error(`Unexpected indent on line: ${line.content}`);
      }
      const content = line.content;
      const colonIdx = findColon(content);
      if (colonIdx === -1) {
        throw new Error(`Expected key: value, got: ${content}`);
      }
      const key = content.slice(0, colonIdx).trim();
      const afterColon = content.slice(colonIdx + 1).trim();
      idx++;
      if (afterColon === "") {
        // nested block
        obj[key] = parseBlock(indent);
      } else {
        obj[key] = parseScalar(afterColon);
      }
    }
    return obj;
  }

  function parseList(indent: number): YamlValue[] {
    const arr: YamlValue[] = [];
    while (idx < cleaned.length) {
      const line = cleaned[idx];
      if (line.indent < indent) break;
      if (line.indent > indent || !line.content.startsWith("- ")) break;
      const afterDash = line.content.slice(2);
      idx++;
      if (afterDash.trim() === "") {
        // "- " alone → nested block follows
        arr.push(parseBlock(indent));
        continue;
      }
      // Check if it's a key: value on the same line as -
      const colonIdx = findColon(afterDash);
      if (colonIdx !== -1 && !afterDash.trim().startsWith('"') && !afterDash.trim().startsWith("'")) {
        // inline map starting with `- key: value`
        // Treat this line's key:value as the first entry in a map, then keep parsing subsequent lines at indent+2.
        const key = afterDash.slice(0, colonIdx).trim();
        const afterKey = afterDash.slice(colonIdx + 1).trim();
        const obj: Record<string, YamlValue> = {};
        if (afterKey === "") {
          obj[key] = parseBlock(indent + 2);
        } else {
          obj[key] = parseScalar(afterKey);
        }
        // continue parsing more map keys at indent + 2
        while (idx < cleaned.length) {
          const nl = cleaned[idx];
          if (nl.indent <= indent) break;
          if (nl.content.startsWith("- ")) break;
          const ci = findColon(nl.content);
          if (ci === -1) break;
          const k2 = nl.content.slice(0, ci).trim();
          const v2 = nl.content.slice(ci + 1).trim();
          idx++;
          if (v2 === "") obj[k2] = parseBlock(nl.indent);
          else obj[k2] = parseScalar(v2);
        }
        arr.push(obj);
      } else {
        arr.push(parseScalar(afterDash));
      }
    }
    return arr;
  }

  return parseBlock(-1);
}

function findColon(s: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === inQuote && s[i - 1] !== "\\") inQuote = null;
    } else {
      if (c === '"' || c === "'") inQuote = c;
      else if (c === ":") return i;
    }
  }
  return -1;
}

function parseScalar(s: string): YamlValue {
  const t = s.trim();
  if (!t) return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((x) => parseScalar(x.trim()));
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  return t;
}

