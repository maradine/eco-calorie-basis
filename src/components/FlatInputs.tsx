import type { EcoData } from "../lib/types";

interface Props {
  inputs: Map<string, number>;
  data: EcoData;
}

export function FlatInputs({ inputs, data }: Props) {
  if (inputs.size === 0) {
    return <div className="overrides__empty">Nothing to harvest — all inputs are crafted.</div>;
  }
  const sorted = [...inputs.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="flat">
      {sorted.map(([item, qty]) => (
        <div className="flat__row" key={item}>
          <span className="flat__qty">{formatQty(qty)}×</span>
          <span className="flat__name">{data.items[item] ?? item}</span>
        </div>
      ))}
    </div>
  );
}

function formatQty(q: number): string {
  if (q === Math.floor(q)) return q.toString();
  if (q < 0.01) return q.toExponential(1);
  return q.toFixed(q < 1 ? 3 : 2);
}
