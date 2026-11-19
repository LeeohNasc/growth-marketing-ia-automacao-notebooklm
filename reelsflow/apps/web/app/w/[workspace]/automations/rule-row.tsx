"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setRuleAction } from "./actions";

export function RuleRow(props: {
  slug: string;
  ruleKey: string;
  title: string;
  description: string;
  enabled: boolean;
  param?: { key: "max_attempts" | "days"; label: string; value: number; min: number; max: number };
  canAdmin: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(props.enabled);
  const [value, setValue] = useState(props.param?.value ?? 0);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (nextEnabled: boolean, nextValue: number) =>
    start(async () => {
      const r = await setRuleAction(props.slug, props.ruleKey, nextEnabled, props.param ? { [props.param.key]: nextValue } : {});
      setMsg(r.ok ? null : (r.message ?? "Erro."));
      router.refresh();
    });
  return (
    <li className="grid gap-2 px-4 py-4 text-sm">
      <div className="flex items-start gap-3">
        <input
          id={`rule-${props.ruleKey}`}
          type="checkbox"
          role="switch"
          aria-checked={enabled}
          checked={enabled}
          disabled={!props.canAdmin || pending}
          onChange={(e) => {
            setEnabled(e.target.checked);
            save(e.target.checked, value);
          }}
          className="mt-1 size-4 accent-[var(--primary)]"
        />
        <label htmlFor={`rule-${props.ruleKey}`} className="grid gap-0.5">
          <span className="font-medium">{props.title}</span>
          <span className="text-muted-foreground">{props.description}</span>
        </label>
      </div>
      {props.param && (
        <div className="ml-7 flex items-center gap-2">
          <Label htmlFor={`param-${props.ruleKey}`} className="text-xs text-muted-foreground">
            {props.param.label}
          </Label>
          <Input
            id={`param-${props.ruleKey}`}
            type="number"
            min={props.param.min}
            max={props.param.max}
            value={value}
            disabled={!props.canAdmin || pending}
            onChange={(e) => setValue(Number(e.target.value))}
            onBlur={() => value !== props.param!.value && save(enabled, value)}
            className="h-8 w-20"
          />
        </div>
      )}
      {msg && <p className="ml-7 text-xs text-destructive">{msg}</p>}
    </li>
  );
}
