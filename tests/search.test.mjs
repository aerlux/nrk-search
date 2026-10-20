import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tokens,fold,seconds,parseSubtitleFile,searchLocal,searchPublished} from '../assets/search.js';

test('Norwegian normalization and timing',()=>{
  assert.deepEqual(tokens('Ærlighet og Øyeblikk!'),['aerlighet','og','oyeblikk']);
  assert.equal(fold('blåbær'),'blabaer');
  assert.equal(seconds(7201000),'02:00:01');
});
test('VTT parser with two cues produces search text with times',()=>{
  const cues=parseSubtitleFile('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nNoe <i>ekte</i>\n\n00:00:03.100 --> 00:00:06.000\nOg tro\n');
  assert.equal(cues.length,1);assert.deepEqual(cues[0],[1000,6000,'Noe ekte Og tro']);
});
test('Local search returns only matching user-supplied segments',()=>{
  const p=[{id:'A',title:'Test program',segments:[[0,5000,'Hva er ekte?'],[6000,9000,'Tro og håp']]}];
  assert.equal(searchLocal(p,'ek',{}).length,1);
  assert.equal(searchLocal(p,'tro',{program:'ikke test'}).length,0);
  assert.equal(searchLocal(p,'tro',{exact:true}).length,1);
});
test('Published index searches posting lists and retrieves segments',async()=>{
  const data={
    'manifest.json':{programs:1,segments:2,blockSize:240},
    'programs.json':[{id:'TEST12345678',title:'Dokumentar',url:'https://tv.nrk.no/program/TEST12345678'}],
    'index/tr.json':{troen:[0],tro:[1]},
    'chunks/0.json':[[0,0,5000,8000,'Troen kan utfordres'],[1,0,12000,15000,'Det handler om tro og tvil']]
  };
  globalThis.fetch=async url=>{
    const key=new URL(url).pathname.substring(new URL(url).pathname.lastIndexOf('/data/')+6);
    return key in data?{ok:true,json:async()=>data[key]}:{ok:false,status:404};
  };
  const found=await searchPublished('tro');
  assert.equal(found.length,2);
  assert.deepEqual(found.map(x=>x.start),[5000,12000]);
  const exact=await searchPublished('tro',{exact:true});
  assert.equal(exact.length,2);
});
