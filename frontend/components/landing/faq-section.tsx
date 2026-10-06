import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const FAQS = [
  {
    q: "Do I need to know electronics to use DunkAI?",
    a: "Describe your hardware idea in plain language. DunkAI prepares a design for review and shows missing components or connections. Electronics knowledge helps you check the result; an engineer should review it before fabrication.",
  },
  {
    q: "Are the parts in the BOM real?",
    a: process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY === 'true'
      ? "The browser checks exact manufacturer identity, actual pins and footprint geometry against the component catalogue. Unresolved mappings are shown as review findings. Generic resistors and capacitors remain unpriced candidates. Unknown stock and prices remain unknown."
      : "Yes. Components are retrieved from a catalogue of real parts with manufacturer part numbers. Where a price or stock level is unknown, the BOM shows it as unknown rather than guessing.",
  },
  {
    q: "What happens when a board fails design-rule checks?",
    a: process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY === 'true'
      ? "The board is not saved as successful. The workspace reports the rule findings so you can revise the design. All browser previews require independent electrical and manufacturing review."
      : "The preview carries a not-ready-to-fabricate notice listing findings. Review and revise the design before ordering it.",
  },
  {
    q: "How do my own API keys work?",
    a: process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY === 'true'
      ? "Add a Groq key in Settings. It stays encrypted on the DunkAI API and uses your provider account for model requests; the browser performs design computation. Local work and BYOK use no DunkAI credits."
      : process.env.NEXT_PUBLIC_BROWSER_PCB_ENABLED === 'true'
      ? "Add a Groq, Gemini or Anthropic key in Settings. We verify it with the provider and store it encrypted. Your key pays the model provider; pipeline compute is 10 DunkAI credits. Supported browser PCB previews use no board credits."
      : "Add a Groq, Gemini or Anthropic key in Settings. We verify it with the provider and store it encrypted. Your key pays the model provider; pipeline compute is 10 DunkAI credits and board compute is 20.",
  },
  {
    q: "How do free chats and credits work?",
    a: process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY === 'true'
      ? "Verified accounts get five hosted model requests each UTC month. A design uses one request, plus one when firmware applies. Each request after the free allowance costs 2 credits. Local compute uses zero credits; purchases open when checkout is enabled."
      : process.env.NEXT_PUBLIC_BROWSER_PCB_ENABLED === 'true'
      ? "Verified accounts get five hosted chat turns each UTC calendar month and 150 trial credits once. After free chats, a chat costs 2 credits. A design pipeline is 30 credits. Supported browser PCB previews use no board credits. You can buy more credits in INR."
      : "Verified accounts get five hosted chat turns each UTC calendar month and 150 trial credits once. After free chats, a chat costs 2 credits. A design pipeline is 30 credits and Groq PCB generation is 101 credits. You can buy more credits in INR.",
  },
  {
    q: "Can I run DunkAI on my own infrastructure?",
    a: process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY === 'true'
      ? "Yes. Host the frontend and Node API, connect Atlas, and configure Groq or BYOK. Design computation runs in each visitor's browser; no separate AI-engine service is required."
      : "Yes. Services ship with Dockerfiles and a Docker Compose configuration. Configure your deployment's model keys, database and execution services.",
  },
];

export function FaqSection() {
  return (
    <section id="faq" className="relative py-24 sm:py-32">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
        <div>
          <p className="text-sm font-medium text-muted-foreground">FAQ</p>
          <h2 className="mt-2 text-4xl font-semibold tracking-[-0.03em]">Questions, answered.</h2>
        </div>
        <Accordion type="single" collapsible className="shadow-soft rounded-[28px] border border-border bg-card px-6">
          {FAQS.map((f, i) => (
            <AccordionItem key={f.q} value={`q${i}`} className={i === FAQS.length - 1 ? "border-b-0" : ""}>
              <AccordionTrigger className="py-5 text-left text-base font-medium hover:no-underline">{f.q}</AccordionTrigger>
              <AccordionContent className="pb-5 text-[15px] leading-relaxed text-muted-foreground">{f.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
