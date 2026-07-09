// Project skills (reusable instructions) and knowledge base with lightweight
// keyword retrieval — top-scoring chunks are injected into phase prompts.
const CHUNK_SIZE = 1200;

const STOP = new Set(
  'the a an and or of to in on for with is are be as at by it this that from should must can will其 các và của cho là'.split(' ')
);

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9À-ỹ]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function chunks(entry) {
  const out = [];
  const content = String(entry.content || '');
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    out.push({ title: entry.title, text: content.slice(i, i + CHUNK_SIZE) });
  }
  return out;
}

export function activeSkills(project) {
  return (project.skills || []).filter((s) => s.enabled !== false);
}

export function retrieveKnowledge(project, task, k = 3) {
  const query = new Set(tokens(`${task.name} ${task.description} ${(task.requirements || []).join(' ')}`));
  if (!query.size) return [];
  const scored = [];
  for (const entry of project.knowledge || []) {
    for (const chunk of chunks(entry)) {
      const words = tokens(`${chunk.title} ${chunk.text}`);
      if (!words.length) continue;
      let hits = 0;
      for (const w of words) if (query.has(w)) hits++;
      const score = hits / Math.sqrt(words.length);
      if (hits > 0) scored.push({ ...chunk, score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

export function contextSections(project, task) {
  const parts = [];
  const skills = activeSkills(project);
  if (skills.length) {
    parts.push(
      'Project skills — standing instructions you MUST follow:\n' +
        skills.map((s) => `### ${s.name}\n${s.instructions}`).join('\n')
    );
  }
  const hits = retrieveKnowledge(project, task);
  if (hits.length) {
    parts.push(
      'Relevant project knowledge (retrieved for this task):\n' +
        hits.map((h) => `### ${h.title}\n${h.text}`).join('\n')
    );
  }
  return parts.length ? '\n\n' + parts.join('\n\n') : '';
}
