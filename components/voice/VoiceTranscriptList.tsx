import {
  voiceTranscriptEmptyLabel, voiceTranscriptSpeakerLabels, voiceTranscriptStateLabels, type VoiceTranscriptCall,
} from "../../lib/voice/transcript-view";

const dateFormat = new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Warsaw" });

/** Read-only list of finished voice interviews of one application (R6 #542). No controls, no export. */
export function VoiceTranscriptList({ calls }: { calls: readonly VoiceTranscriptCall[] }) {
  if (calls.length === 0) return <p role="status">{voiceTranscriptEmptyLabel}</p>;
  return <>
    {calls.map(call => <article key={call.callNo} aria-labelledby={`voice-call-${call.callNo}`}>
      <h2 id={`voice-call-${call.callNo}`}>Rozmowa {call.callNo} · {dateFormat.format(new Date(call.callAt))}</h2>
      {call.state === "available"
        ? <ol>
          {call.lines.map((line, index) => <li key={index}>
            <strong>{voiceTranscriptSpeakerLabels[line.speaker]}:</strong> {line.text}
          </li>)}
        </ol>
        : <p role="status">{voiceTranscriptStateLabels[call.state]}</p>}
    </article>)}
  </>;
}
