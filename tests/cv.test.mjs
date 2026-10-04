import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readCvInput,suggestRedaction,validateCvText} from '../lib/cv-text.ts';
test('suggestions remove known names, email, links and telephone without destroying skills',()=>{
 const text='Łukasz Żółć\nanna@example.com +48 123 456 789\nhttps://linkedin.com/in/test\nJavaScript 2018–2024, SQL, 30% wzrostu.';
 const result=suggestRedaction(text,['Łukasz','Żółć']);
 for(const value of ['Łukasz','Żółć','anna@example.com','123 456 789','linkedin.com']) assert.ok(!result.includes(value));
 assert.match(result,/JavaScript 2018–2024, SQL, 30%/);
 assert.equal(suggestRedaction('Joanna zna Annę; Anna: SQL',['Anna']),'Joanna zna Annę; [DANE OSOBOWE]: SQL');
 assert.equal(suggestRedaction('A+B [Test]',['A+B','[Test]']),'[DANE OSOBOWE] [DANE OSOBOWE]');
});
test('text intake accepts UTF-8 TXT and rejects unsupported, ambiguous and binary inputs',async()=>{
 const form=new FormData();form.set('source_text','  SQL\r\nCRM  ');assert.equal(await readCvInput(form),'SQL\nCRM');
 form.set('cv_file',new File(['Tekst UTF-8: Łódź'], 'cv.txt'));
 await assert.rejects(readCvInput(form),/jedną metodę/);
 form.set('source_text','');assert.equal(await readCvInput(form),'Tekst UTF-8: Łódź');
 for(const file of [new File(['text'],'cv.pdf'),new File(['x'.repeat(200001)],'cv.txt'),new File([new Uint8Array([0xff])],'cv.txt'),new File(['\0binary'],'cv.txt')]) {
  form.set('cv_file',file);await assert.rejects(readCvInput(form));
 }
 for(const value of ['','  ','x'.repeat(100001),'\u0000text']) assert.throws(()=>validateCvText(value));
});
