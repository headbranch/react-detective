import { z } from "zod";
import type { UsedIn } from "./callsites";

// The explanation is produced as structured data (enforced with a JSON schema) so the
// panel can render it as scannable UI instead of a wall of markdown.

const short = (words: number, what: string) => z.string().describe(`${what} At most ~${words} words.`);

export const OUTLINE_KINDS = [
  "state",
  "ref",
  "context",
  "store",
  "hook",
  "derived",
  "memo",
  "callback",
  "function",
  "effect",
  "render",
  "constant",
] as const;

const outlineFields = {
  kind: z
    .enum(OUTLINE_KINDS)
    .describe(
      "state = useState/useReducer, or another built-in holding a value that re-renders (useTransition, useOptimistic, useActionState, useFormStatus); ref = useRef or useImperativeHandle; context = useContext or use(SomeContext); store = useSyncExternalStore (a value read from outside React that re-renders on change); hook = custom or library hook call (also use(promise)); derived = value computed during render, including useDeferredValue and useId; memo = useMemo; callback = useCallback; function = handler or helper; effect = useEffect/useLayoutEffect; render = a component element in the returned JSX, or a conditional / list branch of it, named as written, e.g. '<UserRow>'; constant = module-level value.",
    ),
  name: z.string().describe("The identifier as written, e.g. 'selectedId', 'handleClick', 'initials'. For effects, a short label, e.g. 'sync to localStorage'. For render items, the element as written, e.g. '<UserRow>', '<p>'."),
  line: z.number().int().describe("1-based line in the component's file where it is declared."),
  type: z
    .string()
    .describe(
      [
        "TypeScript type, written as code, using the project's own type names where they exist (e.g. 'User[]' not 'object[]').",
        "state / ref / derived / memo / constant: the value's type, e.g. 'number | null', 'HTMLInputElement | null', 'string'.",
        "context / store / hook: the type of what it returns, e.g. '{ users: User[]; loading: boolean }'.",
        "callback / function: its signature, e.g. '(id: number) => void'.",
        "effect / render: empty string.",
      ].join(" "),
    ),
  initial: z.string().describe("state / ref only: the initial value as code, e.g. '\"\"', 'null', '[]'. Empty string otherwise."),
  returns: z
    .string()
    .describe(
      "function / callback: what calling it gives back, in plain words, e.g. 'nothing; tells the parent which user was clicked' or 'the formatted price'. effect: what its cleanup does, e.g. 'clears the pending timer', or 'no cleanup'. Empty string for other kinds.",
    ),
  when: z
    .string()
    .describe(
      "effect: when it runs: its dependency list like '[query]', 'on mount' or 'every render'. render: when it is shown: 'always', 'if <condition>' (e.g. 'if loading') or 'each <item>' (e.g. 'each user'). Empty string for other kinds.",
    ),
  explanation: short(60, "Shown when the developer clicks the item: what it does and why it exists, in plain language. Mention related items by name. No file paths."),
};

export const CardSchema = z.object({
  summary: short(40, "One short paragraph a new teammate understands: what this component is for in the product, and in plain terms how it does it."),
  props: z
    .array(
      z.object({
        name: z.string(),
        type: z.string().describe("TypeScript type as written, or a short guess if untyped, e.g. 'User', '() => void'."),
        optional: z.boolean(),
        description: short(30, "What this prop is and what the component does with it, in plain language. No file paths or line numbers."),
      }),
    )
    .describe("Every prop the component accepts, in declaration order. Empty if it takes none."),
  outline: z
    .array(
      z.object({
        ...outlineFields,
        children: z
          .array(z.object({ ...outlineFields, children: z.array(z.object(outlineFields)) }))
          .describe("Items inside this one: helpers declared inside a handler or effect, or for render items the components rendered inside it."),
      }),
    )
    .describe("The component's internals in source order, like an IDE outline: state, refs, context, hook calls, derived values, memos, callbacks, handlers, effects, then the notable parts of what it renders. Do not include the component itself as an item."),
  usedIn: z
    .array(z.object({ ref: z.string().describe("Call site as project-relative path:line.") }))
    .describe("Where this component is rendered."),
  history: z
    .array(
      z.object({
        commit: z.string(),
        date: z.string().optional(),
        author: z.string().optional(),
        why: short(25, "What changed and why, from the commit message."),
      }),
    )
    .describe("Only commits whose message explains intent. Empty if there is no useful history."),
  fileNotes: z
    .array(
      z.object({
        file: z.string(),
        summary: short(45, "Factual summary: what it exports, its responsibility, key behaviour."),
        exports: z
          .array(
            z.object({
              name: z.string().describe("The exported name as importers write it; 'default' for the default export."),
              description: short(
                40,
                "What an importer needs to use it without opening the file: what it does, what its arguments mean, what it returns, side effects (fetching, storage, timers, context it requires) and gotchas. Don't repeat the signature.",
              ),
            }),
          )
          .describe("Every export of the file (functions, components, hooks, constants, types), in source order. Empty if it exports nothing."),
      }),
    )
    .describe("One entry for EVERY file you opened with Read in this session. Stored and given to future sessions (including ones about other components that import from these files) so they can skip re-reading."),
});

export const AnswerSchema = z.object({
  answer: z.string().describe("Markdown answer. Lead with the direct answer in one sentence, then at most a few short bullets. Under ~150 words."),
  fileNotes: CardSchema.shape.fileNotes,
});

/** Bumped when the meaning of card fields changes, so older saved cards get regenerated. */
export const CARD_VERSION = 4;

type OutlineFields = {
  type?: string;
  initial?: string;
  when?: string;
  returns?: string;
  /** For a name a custom hook gives (from source only): the returned property, or array position ("0"), it reads. */
  reads?: string;
  /** For context and stores (from source only): what it reads, e.g. "ThemeContext" or "navigator.onLine". */
  from?: string;
  /** For an effect (from source only): the built-in that runs it, e.g. "useLayoutEffect". */
  hook?: string;
};
type RawCard = Omit<z.infer<typeof CardSchema>, "fileNotes">;
type RawItem = RawCard["outline"][number];
/** Any depth: built from source, renders follow the JSX tree. (The model's schema allows two levels.) */
export type OutlineItem = Omit<RawItem, "type" | "initial" | "when" | "returns" | "children"> & OutlineFields & { children: OutlineItem[] };
/** Call sites carry what they pass (read from source), on top of the model's `path:line`. */
export type Card = Omit<RawCard, "outline" | "usedIn"> & { outline: OutlineItem[]; usedIn: UsedIn[]; v?: number };

/** Saved cards from an older CARD_VERSION (or entries with no card) need regenerating. */
export function isCurrentCard(card: unknown): card is Card {
  return !!card && typeof card === "object" && (card as Card).v === CARD_VERSION;
}

// The CLI's validator doesn't know zod's draft-2020-12 `$schema` marker, so drop it.
const toSchema = (s: z.ZodType) => {
  const { $schema: _, ...rest } = z.toJSONSchema(s) as Record<string, unknown>;
  return rest;
};
export const cardJsonSchema = toSchema(CardSchema);
export const answerJsonSchema = toSchema(AnswerSchema);

/** Plain-markdown rendering of a card: stored alongside it and used as prompt context. */
export function cardToMarkdown(card: Card): string {
  const out: string[] = ["## Overview", card.summary];
  if (card.props.length) {
    out.push("", "## Props");
    for (const p of card.props) out.push(`- \`${p.name}${p.optional ? "?" : ""}: ${p.type}\`: ${p.description}`);
  }
  if (card.outline.length) {
    out.push("", "## Inside");
    const list = (items: OutlineItem[], indent: string) => {
      for (const item of items) {
        out.push(`${indent}- ${item.kind} \`${item.name}\` (line ${item.line}${facts(item)}): ${item.explanation}`);
        list(item.children ?? [], `${indent}  `);
      }
    };
    list(card.outline, "");
  }
  if (card.usedIn.length) {
    out.push("", "## Where it's used");
    for (const u of card.usedIn) out.push(`- \`${u.ref}\``);
  }
  if (card.history.length) {
    out.push("", "## History");
    for (const h of card.history) out.push(`- \`${h.commit}\`${h.date ? ` ${h.date}` : ""}${h.author ? ` ${h.author}` : ""}: ${h.why}`);
  }
  return out.join("\n");
}

function facts(item: OutlineFields): string {
  const parts = [item.type && `type ${item.type}`, item.initial && `initially ${item.initial}`, item.when, item.returns && `returns ${item.returns}`].filter(Boolean);
  return parts.length ? `, ${parts.join(", ")}` : "";
}
