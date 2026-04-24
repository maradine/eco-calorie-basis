import { useMemo, useRef, useState, useEffect } from "react";
import type { EcoData } from "../lib/types";

interface Props {
  data: EcoData;
  selected: string | null;
  onSelect: (item: string) => void;
  qty: number;
  onQtyChange: (qty: number) => void;
}

export function Picker({ data, selected, onSelect, qty, onQtyChange }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Restrict search to items that actually have a recipe OR are raw-harvest
  // leaves used as ingredients — i.e., the items you'd plausibly want to
  // compute a basis for. Tools, food, and crafted items all qualify; the
  // complete catalog of 1300+ entries is the universe.
  const searchable = useMemo(() => {
    return Object.entries(data.items).map(([id, name]) => ({
      id,
      name,
      hasRecipe: (data.producers[id]?.length ?? 0) > 0,
    }));
  }, [data]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    // Score by: exact prefix, word prefix, substring, then id prefix.
    return searchable
      .map((item) => {
        const nm = item.name.toLowerCase();
        const id = item.id.toLowerCase();
        let score = 0;
        if (nm === q) score = 1000;
        else if (nm.startsWith(q)) score = 800;
        else if (nm.split(" ").some((w) => w.startsWith(q))) score = 600;
        else if (nm.includes(q)) score = 400;
        else if (id.includes(q)) score = 200;
        // Prefer items with recipes (what you typically want to cost)
        if (item.hasRecipe) score += 5;
        return { ...item, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }, [query, searchable]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  function pick(id: string, name: string) {
    onSelect(id);
    setQuery(name);
    setOpen(false);
    inputRef.current?.blur();
  }

  const selectedName = selected ? data.items[selected] ?? selected : "";

  return (
    <div className="picker">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
        <input
          ref={inputRef}
          className="picker__input"
          type="text"
          placeholder="Search: Hewn Dresser, Iron Pickaxe, Steel Bar…"
          value={open ? query : query || selectedName}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            if (selected) setQuery("");
          }}
          onBlur={() => {
            // delay so click on result fires first
            setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={(e) => {
            if (!open || results.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const r = results[active];
              if (r) pick(r.id, r.name);
            } else if (e.key === "Escape") {
              setOpen(false);
              inputRef.current?.blur();
            }
          }}
        />
        <input
          className="picker__input"
          type="number"
          min={0.01}
          step={1}
          value={qty}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v) && v > 0) onQtyChange(v);
          }}
          style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
          aria-label="Quantity"
        />
      </div>

      {open && results.length > 0 && (
        <div className="picker__results">
          {results.map((r, i) => (
            <div
              key={r.id}
              className={
                "picker__result" + (i === active ? " picker__result--active" : "")
              }
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r.id, r.name);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{r.name}</span>
              <span className="picker__result__id">
                {r.hasRecipe ? "" : "raw · "}
                {r.id}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
