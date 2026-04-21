/**
 * TunablesColumn — grouped <details> blocks for the schema's tunables.
 *
 * Renders one <details> per category, then one <Tunable> per spec inside.
 * Validation errors and the draft override come from the parent page.
 *
 * Stateless — SettingsPage owns the draft / effective / errors maps and
 * just hands them in here.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: the left-hand column listing all tunables, grouped by
 *   category in collapsible sections.
 */

import { humanize } from "../utils/formatting";
import type { DraftValue, EffectiveSettings, SettingSpec } from "../types";

import { Tunable } from "./Tunable";

import styles from "../SettingsPage.module.css";

/**
 * Props. `Array<[string, SettingSpec[]]>` is a tuple type — each entry
 * is a `[category, specs]` pair. Using a sorted array (not a Map) keeps
 * category order stable across renders.
 */
interface TunablesColumnProps {
  groupedSpecs: Array<[string, SettingSpec[]]>;
  effective: EffectiveSettings;
  draft: Record<string, DraftValue>;
  errorByKey: Record<string, string>;
  onChange: (key: string, value: DraftValue) => void;
}

/**
 * Render each category as a collapsible <details> and delegate each
 * individual row to <Tunable>. The draft value falls back to the
 * effective (saved) value when the operator hasn't touched the key yet.
 */
export function TunablesColumn({
  groupedSpecs,
  effective,
  draft,
  errorByKey,
  onChange,
}: TunablesColumnProps) {
  return (
    <>
      {/* Destructured tuple `[cat, specs]` — the two parts of each entry. */}
      {groupedSpecs.map(([cat, specs]) => (
        <details key={cat} className={styles.category} open>
          <summary>
            {humanize(cat)} <span style={{ float: "right", fontSize: 10 }}>{specs.length}</span>
          </summary>
          <div className={styles.categoryBody}>
            {specs.map((spec) => {
              // `as DraftValue` is a TS assertion — narrows the type
              // because effective.values is a generic Record and we know
              // the key points at a DraftValue.
              const eff = effective.values[spec.key] as DraftValue;
              const cur = (draft[spec.key] ?? eff) as DraftValue;
              return (
                <Tunable
                  key={spec.key}
                  spec={spec}
                  effective={eff}
                  draft={cur}
                  errorReason={errorByKey[spec.key] ?? null}
                  onChange={(v) => onChange(spec.key, v)}
                />
              );
            })}
          </div>
        </details>
      ))}
    </>
  );
}
