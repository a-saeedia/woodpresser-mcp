const {spawn}=require('child_process'); const fs=require('fs');
const out=fs.openSync('D:/projects/woodpresser/tests/it.log','w');
const p=spawn('C:/Users/User/tools/node/node.exe',['tests/integration-playground.mjs'],{detached:true,stdio:['ignore',out,out],cwd:'D:/projects/woodpresser',env:process.env,shell:false});
p.unref(); fs.writeSync(1,'pid='+p.pid+'\n'); process.exit(0);
