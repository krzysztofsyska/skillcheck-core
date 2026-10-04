export const behaviorAreas = [
  ["responsibility", "Odpowiedzialność"],
  ["independence", "Samodzielność"],
  ["initiative", "Inicjatywa"],
  ["results", "Orientacja na wynik"],
  ["cooperation", "Współpraca z ludźmi"],
  ["change", "Reakcja na zmianę"],
  ["feedback", "Otwartość na informację zwrotną"],
  ["pressure", "Działanie pod presją i w trudnych sytuacjach"],
] as const;
export const requirementLevels = ["Niski", "Standardowy", "Wysoki", "Krytyczny"] as const;
export type EditorState = { error?: string; saved?: boolean };
export function parsePosition(form: FormData) {
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const lines = (name: string) => text(name).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const title = text("title");
  const description = text("description");
  const tasks = lines("tasks"), kpis = lines("kpis"), competencies = lines("required_competencies");
  const autonomyText = text("autonomy_level");
  if (!title || title.length > 200) throw new Error("Podaj nazwę stanowiska (do 200 znaków).");
  if (!tasks.length || !kpis.length) throw new Error("Podaj co najmniej jedno zadanie i jeden miernik sukcesu.");
  if (description.length > 10000 || [tasks, kpis, competencies].some(list => list.length > 30 || list.some(item => item.length > 500))) throw new Error("Skróć opis do 10 000 znaków i listy do 30 pozycji po 500 znaków.");
  if (!/^[1-5]$/.test(autonomyText)) throw new Error("Wybierz poziom samodzielności od 1 do 5.");
  const required_behaviors = behaviorAreas.map(([key, label]) => {
    const level = text(key);
    if (!(requirementLevels as readonly string[]).includes(level)) throw new Error("Wybierz wymagany poziom dla każdego z ośmiu obszarów.");
    return label + ": " + level;
  });
  return { title, description: description || null, tasks, kpis, autonomy_level: Number(autonomyText), required_competencies: competencies, required_behaviors };
}
