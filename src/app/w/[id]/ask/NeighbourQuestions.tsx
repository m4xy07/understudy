"use client";
// "Questions for you": shown to a role that the ladder asked. The answer is labelled Second-hand.
// The role comes from the cookie on the server; this form only sends the step, the text and the
// roles the neighbour kept ticked.
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { Chip } from "@/components/chips";
import type { NeighbourQuestion, NeighbourReply } from "@/lib/lacuna";
import { answerAsNeighbourAction } from "./actions";

interface RoleOption {
  key: string;
  label: string;
}

function QuestionCard({ ws, q, roles, approver }: { ws: string; q: NeighbourQuestion; roles: RoleOption[]; approver: string }) {
  const [text, setText] = useState("");
  const shown = roles.filter((r) => q.defaultRoles.includes(r.key));
  return (
    <li className="card p-4">
      <p className="max-w-3xl text-ink">{q.text}</p>
      <p className="mt-1 text-xs text-muted">
        <span className="mono">{q.responsibilityKey}</span> {q.responsibilityTitle} · {q.checkLabel}
      </p>
      <p className="mt-1 text-sm text-muted">Why you: {q.reason.charAt(0).toLowerCase() + q.reason.slice(1)}.</p>
      <ActionForm action={answerAsNeighbourAction} hidden={{ ws, stepId: q.stepId }} className="mt-3 grid gap-2">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">What you know</span>
          <textarea
            name="answer"
            maxLength={4000}
            rows={3}
            className="field"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-describedby={`help-${q.stepId}`}
          />
          <span id={`help-${q.stepId}`} className="text-xs text-muted">
            Say only what you know yourself. If you are guessing, say so.
          </span>
        </label>
        {q.sample && (
          <div>
            <button type="button" className="text-sm text-attest underline" onClick={() => setText(q.sample ?? "")}>
              Use a sample answer
            </button>
          </div>
        )}
        <fieldset className="text-sm">
          <legend className="font-medium">Who can see this answer</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {shown.map((o) =>
              q.keep.includes(o.key) ? (
                <label key={o.key} className="inline-flex items-center gap-1.5 text-muted">
                  <input type="hidden" name="roles" value={o.key} />
                  <input type="checkbox" checked disabled className="h-4 w-4" />
                  {o.label}
                </label>
              ) : (
                <label key={o.key} className="inline-flex items-center gap-1.5">
                  <input type="checkbox" name="roles" value={o.key} defaultChecked className="h-4 w-4" />
                  {o.label}
                </label>
              ),
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            It starts with the roles that can already see the records on this topic. You can narrow it, never widen it.
            You and {approver} always keep it.
          </p>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <SubmitButton name="intent" value="answer" pendingText="Saving and re-testing…">Save answer</SubmitButton>
          <SubmitButton name="intent" value="decline" className="btn-quiet" pendingText="Saving…">I don&apos;t know</SubmitButton>
        </div>
      </ActionForm>
    </li>
  );
}

export function NeighbourQuestions({
  ws, questions, replies, roles, leaver, approver,
}: { ws: string; questions: NeighbourQuestion[]; replies: NeighbourReply[]; roles: RoleOption[]; leaver: string; approver: string }) {
  const people = [...new Map(questions.map((q) => [q.personId, q.personName])).entries()];
  const [person, setPerson] = useState(people[0]?.[0] ?? "");
  const active = people.some(([id]) => id === person) ? person : people[0]?.[0] ?? "";
  const mine = people.length > 1 ? questions.filter((q) => q.personId === active) : questions;
  if (questions.length === 0 && replies.length === 0) return null;
  return (
    <section className="mb-8" aria-label="Questions for you">
      <h2 className="mb-1 text-xl">Questions for you ({questions.length})</h2>
      <p className="mb-3 max-w-3xl text-sm text-ink-2">
        {leaver} can&apos;t be reached, and the record shows you worked on these together. Say what you know. Your answer is
        labelled Second-hand: it helps, but it does not count as a record.
      </p>
      {people.length > 1 && (
        <label className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-muted">Answering as</span>
          <select className="field min-h-9 w-auto py-1 pr-8" value={active} onChange={(e) => setPerson(e.target.value)}>
            {people.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </label>
      )}
      {questions.length === 0 && <p className="mb-3 text-sm text-muted">Nothing is waiting for you.</p>}
      <ol className="grid gap-3">
        {mine.map((q) => (
          <QuestionCard key={q.stepId} ws={ws} q={q} roles={roles} approver={approver} />
        ))}
      </ol>
      {replies.length > 0 && (
        <>
          <h3 className="mt-5 mb-2 text-base font-semibold">Your replies ({replies.length})</h3>
          <ul className="grid gap-2">
            {replies.map((r) => (
              <li key={r.stepId} className="card grid gap-1 p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="max-w-3xl">{r.text}</span>
                  {r.status === "answered"
                    ? <Chip symbol="↪" label="Second-hand" tone="warn" />
                    : <Chip symbol="○" label="No answer" tone="hold" />}
                </div>
                {r.status === "answered" ? (
                  <>
                    {r.statement && <p className="text-ink-2">{r.statement}</p>}
                    <p role="status" className="text-xs text-ok">
                      <span aria-hidden="true">✓ </span>
                      Saved as &quot;Second-hand&quot;.{r.scoreDelta ? <> Re-test: <span className="mono text-ink-2">{r.scoreDelta}</span></> : null}
                    </p>
                  </>
                ) : (
                  <p role="status" className="text-xs text-muted">Noted. Nothing was saved as evidence.</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
