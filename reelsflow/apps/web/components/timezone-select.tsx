"use client";
import { useMemo } from "react";
import { DEFAULT_TIMEZONE } from "@reelsflow/domain";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TimezoneSelect({ name = "timezone", defaultValue, error }: { name?: string; defaultValue?: string; error?: string }) {
  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [DEFAULT_TIMEZONE];
    return list.includes("UTC") ? list : [...list, "UTC"];
  }, []);
  return (
    <div className="grid gap-2">
      <Label htmlFor={name}>Fuso horário</Label>
      <NativeSelect id={name} name={name} defaultValue={defaultValue ?? DEFAULT_TIMEZONE} aria-invalid={error ? true : undefined}>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replaceAll("_", " ")}
          </option>
        ))}
      </NativeSelect>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">Usado para interpretar os horários de publicação.</p>
      )}
    </div>
  );
}
