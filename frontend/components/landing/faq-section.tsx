import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const FAQS = [
  {
    q: "Do I need to know electronics to use DunkAI?",
    a: "No, though it helps you review the output. The Requirements Agent asks plain-language questions, and every stage explains what it chose. An engineer should still review a board before you order it fabricated.",
  },
  {
    q: "Are the parts in the BOM real?",
    a: "Yes. Components are retrieved from a catalogue of real parts with manufacturer part numbers. Where a price or stock level is unknown, the BOM shows it as unknown rather than guessing.",
  },
  {
    q: "What happens when a board fails design-rule checks?",
    a: "It is still shown, because the layout is how you see what went wrong, but it carries a clear 'not ready to fabricate' banner listing the errors. You can ask the agents to revise just that stage.",
  },
  {
    q: "How do my own API keys work?",
    a: "Add a Groq, Gemini or Anthropic key in Settings. We verify it with the provider and store it encrypted. Your key pays the model provider; pipeline compute is 10 DunkAI credits and board compute is 20.",
  },
  {
    q: "How do free chats and credits work?",
    a: "Verified accounts get five hosted chat turns each UTC calendar month and 150 trial credits once. After free chats, a chat costs 2 credits. A design pipeline is 30 credits and Groq PCB generation is 101 credits. You can buy more credits in INR.",
  },
  {
    q: "Can I run DunkAI on my own infrastructure?",
    a: "Yes. Every service ships with a Dockerfile and a docker-compose file. Self-hosted installs run without usage limits, and can use the agentic Claude Code board generator.",
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
