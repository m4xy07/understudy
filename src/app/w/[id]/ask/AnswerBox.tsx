"use client";
// The leaver's answer box. In a demo, the top question offers a sample answer so a visitor
// who does not know the fictional setting can still try the step.
import { useState } from "react";

export function AnswerBox({ sample }: { sample?: string }) {
  const [text, setText] = useState("");
  return (
    <>
      <label className="grid gap-1 text-sm">
        <span className="font-medium">Your answer</span>
        <textarea
          name="answer"
          required
          minLength={2}
          maxLength={4000}
          rows={3}
          className="field"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {sample && (
        <div>
          <button type="button" className="text-sm text-attest underline" onClick={() => setText(sample)}>
            Use a sample answer
          </button>
        </div>
      )}
    </>
  );
}
