import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidate } from '../lib/candidate-fields.ts';
function form(fields = {}) {
 const result = new FormData();
 for (const [key,value] of Object.entries({first_name:' Anna ',last_name:'Nowak',...fields})) result.set(key,value);
 return result;
}
test('candidate accepts international names, optional contact and trims whitespace',()=>{
 assert.deepEqual(parseCandidate(form()),{first_name:'Anna',last_name:'Nowak',email:null,phone:null});
 assert.deepEqual(parseCandidate(form({last_name:"O’Connor",email:' anna@example.com ',phone:'+48 (123) 456-789'})),{first_name:'Anna',last_name:'O’Connor',email:'anna@example.com',phone:'+48 (123) 456-789'});
});
test('candidate rejects missing names, excessive data and malformed contacts',()=>{
 for(const fields of [{first_name:' '},{last_name:''},{last_name:'x'.repeat(101)},{email:'a@'},{email:'a b@example.com'},{phone:'call me'},{phone:'---'},{phone:'1'.repeat(41)}]) assert.throws(()=>parseCandidate(form(fields)));
});
