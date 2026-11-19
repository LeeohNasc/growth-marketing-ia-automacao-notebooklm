import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PhasePlaceholder } from "@/components/phase-placeholder";
import { findNavItem } from "@/lib/nav";

type Props = { params: Promise<{ workspace: string; section: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { section } = await params;
  return { title: findNavItem(section)?.label ?? "Não encontrado" };
}

export default async function SectionPage({ params }: Props) {
  const { section } = await params;
  const item = findNavItem(section);
  if (!item) notFound();
  return <PhasePlaceholder item={item} />;
}
