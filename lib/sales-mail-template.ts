/** Immutable v1 payload: keep unchanged while jobs may be retried with the same idempotency key. */
export function salesMailTemplateV1() {
  const subject = 'SkillCheck — otrzymaliśmy Twoje zgłoszenie';
  const paragraphs = [
    'Dzień dobry,',
    'dziękujemy za kontakt i zainteresowanie SkillCheck. Twoje zgłoszenie zostało zapisane.',
    'Dobra rekrutacja zaczyna się od zrozumienia, kogo naprawdę potrzebuje Twoja firma. CV pokazuje doświadczenie kandydata. W rekrutacji potrzebujemy jednak odpowiedzi na ważniejsze pytanie: czy ta osoba poradzi sobie z zadaniami, które rzeczywiście czekają na nią w firmie?',
    'Od tego chcemy zacząć naszą rozmowę — od stanowiska, oczekiwanych wyników i tego, co warto sprawdzić przed podjęciem decyzji o zatrudnieniu.',
    'Jeśli tych informacji nie było w zgłoszeniu, odpowiedz na tego e-maila i napisz:',
  ];
  const questions = [
    'Na jakie stanowisko rekrutujesz?',
    'Jakie najważniejsze zadanie będzie miała do wykonania zatrudniona osoba?',
    'Co dziś sprawia największą trudność: liczba CV, ocena kompetencji czy wybór spośród kilku kandydatów?',
    'Kiedy chcesz zakończyć rekrutację?',
  ];
  const closing = [
    'Nie musisz powtarzać informacji podanych w formularzu. Na tym etapie nie przesyłaj CV ani danych osobowych kandydatów.',
    'Zapoznamy się ze zgłoszeniem i odpowiemy z propozycją dalszych kroków. Jeżeli wygodniej będzie porozmawiać, możesz wskazać dogodny termin. Samo zgłoszenie nie rezerwuje terminu rozmowy.',
    'Pozdrawiamy,\nZespół SkillCheck\npomoc@skillcheck.pl\nhttps://skillcheck.pl',
    'To automatyczne potwierdzenie otrzymania zgłoszenia. Możesz na nie odpowiedzieć — wiadomość trafi do naszej obsługi.',
    'KTIG CONSULTING Sp. z o.o.\nul. Michała Kajki 10–12, 10-547 Olsztyn\nInformacje o danych osobowych: https://skillcheck.pl/prywatnosc',
  ];
  const escape = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const p = (s: string) => `<p style="margin:0 0 18px;line-height:1.65">${escape(s).replace(/\n/g,'<br>')}</p>`;
  return {
    from: 'SkillCheck <pomoc@skillcheck.pl>', reply_to: 'pomoc@skillcheck.pl', subject,
    text: [...paragraphs,questions.map((q,i)=>`${i+1}. ${q}`).join('\n'),...closing].join('\n\n'),
    html: `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f6fb;color:#172b4d;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" style="width:100%;max-width:600px;background:#fff;border:1px solid #dbe6f3;border-radius:12px"><tr><td style="padding:28px;background:#eaf2ff;color:#124c99"><strong style="font-size:24px">SkillCheck</strong><h1 style="font-size:23px;line-height:1.35">Dziękujemy. Twoje zgłoszenie dotarło.</h1></td></tr><tr><td style="padding:28px;font-size:16px">${paragraphs.map(p).join('')}<ol style="padding-left:22px;line-height:1.65">${questions.map(q=>`<li style="margin-bottom:10px">${escape(q)}</li>`).join('')}</ol>${closing.map(p).join('')}</td></tr></table></td></tr></table></body></html>`,
  };
}
