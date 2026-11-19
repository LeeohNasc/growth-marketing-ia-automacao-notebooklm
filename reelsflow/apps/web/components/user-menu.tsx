"use client";
import { useRef } from "react";
import Link from "next/link";
import { LogOut, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function UserMenu({ name, email }: { name: string; email: string }) {
  const initial = (name || email).slice(0, 1).toUpperCase();
  const signOutForm = useRef<HTMLFormElement>(null);
  return (
    <>
    <form ref={signOutForm} action="/auth/signout" method="post" hidden />
    <DropdownMenu>
      <DropdownMenuTrigger
        className="grid size-9 place-items-center rounded-full bg-secondary text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Menu da conta"
      >
        {initial}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-foreground">
          <span className="block truncate font-medium">{name || "Sem nome"}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserRound aria-hidden /> Minha conta
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => signOutForm.current?.requestSubmit()}>
          <LogOut aria-hidden /> Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}
