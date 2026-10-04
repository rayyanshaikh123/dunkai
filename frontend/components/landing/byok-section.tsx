import Link from "next/link";
import { BadgeCheck, EyeOff, Coins, Lock } from "lucide-react";

const PROVIDERS = [
  { name: "Groq", use: "Design chat and all six agents", color: "#f55036" },
  { name: "Google Gemini", use: "Board generation", color: "#4f8cff" },
  { name: "Anthropic", use: "Claude board generation", color: "#d97757" },
];

const PROMISES = [
  { icon: BadgeCheck, title: "Verified on save", body: "We make one read-only call to the provider, so a typo fails now, not three minutes into a run." },
  { icon: Lock, title: "Encrypted at rest", body: "AES-256-GCM, decrypted only for the request that uses it, and only on our servers." },
  { icon: EyeOff, title: "Never sent back", body: "Your browser only ever sees the last four characters. Remove a key any time." },
  { icon: Coins, title: "Compute only", body: "Your key pays the model provider. Pipeline and board compute use fewer DunkAI credits." },
];

export function ByokSection() {
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
                Add your own provider key to pay that provider directly. DunkAI charges only the disclosed compute credits for pipeline and board jobs.
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
                Add a key in Settings
              </Link>
            </div>

            <div className="page-wash grid gap-3 p-6 sm:grid-cols-2 sm:p-10">
              {PROMISES.map(({ icon: Icon, title, body }) => (
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
