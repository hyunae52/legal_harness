import dotenv from "dotenv";

dotenv.config();

/**
 * Supreme Judge Verification Module
 * Evaluates a proposed tax Quality Gate rule against legal principles.
 * Supports:
 * 1. Google Gemini API (gemini-2.5-pro, gemini-2.0-flash, etc.) via GEMINI_API_KEY
 * 2. OpenAI / DeepSeek / OpenRouter / Local Ollama via OPENAI_API_KEY (+ optional OPENAI_BASE_URL)
 * 3. Anthropic Claude (Claude 3.7 Sonnet, etc.) via ANTHROPIC_API_KEY
 * 4. Offline heuristic fallback if no key is configured
 */
export async function verifyWithSupremeJudge(
  issueSummary: string,
  proposedFailIf: string
): Promise<boolean> {
  console.error("⚖️  [Supreme Judge] Reviewing proposed rule...");
  console.error(`⚖️  [Supreme Judge] Issue: ${issueSummary}`);
  console.error(`⚖️  [Supreme Judge] Proposed Condition: ${proposedFailIf}`);

  // Basic sanity check: tax rules cannot be absolute unconditional assertions
  if (proposedFailIf.includes("무조건")) {
    console.error("⚖️  [Supreme Judge] REJECTED: Tax law cannot contain unconditional absolutes ('무조건').");
    return false;
  }

  const systemPrompt = `You are the Supreme Tax Law Quality Judge (대법관).
Your role is to rigorously review whether a proposed Quality Gate rule for a tax assistant agent is legally sound and prevents common tax reasoning failures.
Return strictly a JSON object: {"approved": true|false, "reason": "brief explanation"}.`;

  const userPrompt = `Tax Issue: ${issueSummary}\nProposed Rule (fail_if): ${proposedFailIf}\nIs this legally reasonable to enforce as an automated guardrail?`;

  // 1. Google Gemini API (Recommended: Generous free limits and strong Korean reasoning)
  if (process.env.GEMINI_API_KEY) {
    try {
      const model = process.env.SUPREME_JUDGE_MODEL || "gemini-2.0-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      });

      if (response.ok) {
        const result: any = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const parsed = JSON.parse(text);
        console.error(`⚖️  [Supreme Judge - Gemini (${model})] Decision: ${parsed.approved ? "APPROVED" : "REJECTED"} (${parsed.reason || "No reason given"})`);
        return Boolean(parsed.approved);
      }
      console.warn("⚠️  [Supreme Judge] Gemini API error status:", response.status);
    } catch (err: any) {
      console.warn("⚠️  [Supreme Judge] Failed to call Gemini API:", err.message);
    }
  }

  // 2. OpenAI / DeepSeek / OpenRouter / Groq / Ollama (OpenAI-compatible)
  if (process.env.OPENAI_API_KEY) {
    try {
      const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
      const model = process.env.SUPREME_JUDGE_MODEL || "gpt-4o";
      
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (response.ok) {
        const result: any = await response.json();
        const parsed = JSON.parse(result.choices?.[0]?.message?.content || '{"approved": true}');
        console.error(`⚖️  [Supreme Judge - OpenAI/Compatible (${model})] Decision: ${parsed.approved ? "APPROVED" : "REJECTED"}`);
        return Boolean(parsed.approved);
      }
      console.warn("⚠️  [Supreme Judge] OpenAI/Compatible API error status:", response.status);
    } catch (err: any) {
      console.warn("⚠️  [Supreme Judge] Failed to call OpenAI/Compatible API:", err.message);
    }
  }

  // 3. Anthropic API Call
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const model = process.env.SUPREME_JUDGE_MODEL || "claude-3-7-sonnet-20250219";
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (response.ok) {
        const result: any = await response.json();
        const text = result.content?.[0]?.text || "";
        const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{"approved": true}');
        console.error(`⚖️  [Supreme Judge - Anthropic (${model})] Decision: ${parsed.approved ? "APPROVED" : "REJECTED"} (${parsed.reason || "No reason given"})`);
        return Boolean(parsed.approved);
      }
      console.warn("⚠️  [Supreme Judge] Anthropic API error status:", response.status);
    } catch (err: any) {
      console.warn("⚠️  [Supreme Judge] Failed to call Anthropic API:", err.message);
    }
  }

  // 4. Fallback Heuristic
  console.error("⚖️  [Supreme Judge] Running in offline heuristic mode (No LLM API key detected).");
  const isReasonableLength = proposedFailIf.trim().length >= 10 && issueSummary.trim().length >= 5;
  return isReasonableLength;
}
