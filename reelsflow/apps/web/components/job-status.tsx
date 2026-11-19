import { JOB_STATUS_LABELS, JOB_STATUS_TONE, type JobStatus } from "@reelsflow/domain";
import { cn } from "@/lib/utils";

const TONE = {
  neutral: "bg-secondary text-secondary-foreground",
  progress: "bg-primary/15 text-primary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
} as const;

export function JobStatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", TONE[JOB_STATUS_TONE[status]], className)}>
      {JOB_STATUS_LABELS[status]}
    </span>
  );
}

export const STATUS_DOT: Record<string, string> = {
  neutral: "bg-muted-foreground",
  progress: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};
