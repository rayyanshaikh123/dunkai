"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, EyeOff, Coins, Lock } from "lucide-react";
import { billingApi } from "@/lib/api";

const PROVIDERS = [
  { name: "Groq", use: "Original design agents and PCB generation", color: "#f55036" },
];
const LOCAL_PROMISES = [
  { icon: BadgeCheck, title: "Your provider account", body: "Models run remotely on Groq using your account's allowance and rate limits." },
  { icon: Lock, title: "Stored on your computer", body: "Your BYOK key stays in your local runtime configuration." },
  { icon: EyeOff, title: "No key uploads", body: "BYOK requests go directly from your computer to Groq." },
  { icon: Coins, title: "Free local compute", body: "Local orchestration and PCB generation use zero DunkAI credits." },
];
const HOSTED_PROMISES = [
  { icon: BadgeCheck, title: "Your provider account", body: "Your provider bills its model usage to your account." },
  { icon: Lock, title: "Encrypted storage", body: "Saved provider keys are encrypted by the backend." },
  { icon: EyeOff, title: "Authorized jobs", body: "Keys are passed securely to the engine for your authenticated requests." },
  { icon: Coins, title: "Separate compute costs", body: "BYOK avoids hosted model charges. Published server computation credits still apply." },
];

export function ByokSection() {
  const [local, setLocal] = useState<boolean | null>(null);
  useEffect(() => { billingApi.plans().then((plans) => setLocal(plans.localRuntimeEnabled)).catch(() => {}) }, []);
  const promises = local ? LOCAL_PROMISES : HOSTED_PROMISES;
  return (
    <section id="byok" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="shadow-soft overflow-hidden rounded-[36px] border border-border bg-card">
          <div className="grid lg:grid-cols-[1.05fr_1fr]">
            <div className="p-8 sm:p-12">
              <p className="text-sm font-medium text-muted-foreground">Bring your own keys</p>
              <h2 className="mt-2 text-4xl font-semibold tracking-[-0.03em] sm:text-[44px] sm:leading-[1.08]">
                Your models.
                <br />
                <span className="text-soft">Your model bill.</span>
              </h2>
              <p className="mt-4 max-w-md text-lg text-muted-foreground">
                {local === true ? "Set your Groq key in the local runtime to pay your provider directly. Your computer runs the design agents and PCB generator for zero DunkAI credits."
                  : local === false ? "Add your Groq key in Settings to use your provider account. The hosted engine runs the design agents and PCB generator, so your computer only needs the website."
                  : "Use your own provider account for supported design jobs. Settings shows the available providers and computation pricing."}
              </p>

              <ul className="mt-8 space-y-3">
                {PROVIDERS.map((p) => (
                  <li key={p.name} className="flex items-center justify-between rounded-2xl border border-border bg-background/60 px-4 py-3">
                    <span className="flex items-center gap-3 font-medium">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
                      {p.name}
                    </span>
                    <span className="text-sm text-muted-foreground">{p.use}</span>
                  </li>
                ))}
              </ul>

              <Link
                href="/settings"
                className="mt-8 inline-flex items-center rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                {local ? "Connect your computer in Settings" : "Manage API keys in Settings"}
              </Link>
            </div>

            <div className="page-wash grid gap-3 p-6 sm:grid-cols-2 sm:p-10">
              {promises.map(({ icon: Icon, title, body }) => (
                <div key={title} className="glass rounded-3xl p-5">
                  <Icon className="h-5 w-5 text-[var(--brand-1)]" />
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
