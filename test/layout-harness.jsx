/**
 * Test harness for rendering GamePhase / ReviewGamePhase in isolation.
 * Served by Vite at /test/layout-harness.html so Playwright can drive it.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { _GamePhase as GamePhase, _ReviewGamePhase as ReviewGamePhase, _STYLES as STYLES } from "../src/App.jsx";

// Fixture data — 3 words with deterministic options (correct answer is always index 0)
const FIXTURES = [
  {
    word: "tenacious",
    paragraph: "Her tenacious grip on the rope was the only thing keeping her from falling.",
    options: { correct: 0, options: ["persistent and determined", "weak and fragile", "loud and boisterous", "calm and peaceful"] },
    hint: "Think about holding on tightly — what quality would that require?",
    image: null,
  },
  {
    word: "ephemeral",
    paragraph: "The ephemeral beauty of the cherry blossoms reminded her that nothing lasts forever.",
    options: { correct: 0, options: ["lasting a very short time", "extremely beautiful", "related to flowers", "ancient and weathered"] },
    hint: "Cherry blossoms fall quickly — what word describes something short-lived?",
    image: null,
  },
  {
    word: "cacophony",
    paragraph: "The cacophony of car horns and jackhammers made it impossible to concentrate.",
    options: { correct: 0, options: ["harsh discordant mixture of sounds", "a type of musical instrument", "a feeling of deep calm", "bright colorful display"] },
    hint: "Car horns and jackhammers together — what kind of sound would that be?",
    image: null,
  },
];

// Review fixtures — each word gets a single exercise type assigned
const REVIEW_FIXTURES = FIXTURES.map((f, i) => ({
  ...f,
  exerciseType: "meaning",
}));

function Harness() {
  const [mode, setMode] = useState(null); // null | "game" | "review"
  const [done, setDone] = useState(false);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      {!mode && (
        <div style={{ padding: 20 }}>
          <button id="start-game" onClick={() => setMode("game")}>Start Game</button>
          <button id="start-review" onClick={() => setMode("review")} style={{ marginLeft: 8 }}>Start Review</button>
        </div>
      )}
      {mode && !done && (
        <div className={`app game-active`}>
          {mode === "game" ? (
            <GamePhase assets={FIXTURES} bookTitle="Test Book" chapterTitle="Ch 1" onDone={() => setDone(true)} />
          ) : (
            <ReviewGamePhase assets={REVIEW_FIXTURES} onDone={() => setDone(true)} />
          )}
        </div>
      )}
      {done && <div id="done-marker">Done</div>}
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode><Harness /></StrictMode>
);
