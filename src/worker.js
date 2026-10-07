case "game:start": {
  const seat=this.auth(att); if(!seat) return ERR("AUTH","認証に失敗しました。");
  const room=this.room;
  if(!room.players[seat].host) return ERR("NOT_HOST","開始できるのはホストのみです");
  if(!room.players.P1||!room.players.P2) return ERR("NEED2","2名そろってから開始してください");
  if(room.game.status==="playing") return ERR("ALREADY","すでに対戦中です");
  const g=G.newState();
  let first="P1";
  if(room.settings.firstPlayer==="random") first=Math.random()<0.5?"P1":"P2";
  else if(room.settings.firstPlayer==="P2") first="P2";
  g.turn=first; g.status="playing"; g.turnStartedAt=nowT; g.positions[G.positionKey(g)]=1;
  room.game=g; room.rematch={P1:false,P2:false}; room.startedOnce=true; room.gameCount=(room.gameCount||0)+1; room.lastActiveAt=nowT;
  await this.save();
  this.broadcastState({started:true});
  return reply({ev:"ok", room:this.pub(), seat});   // ← ここを修正
}
