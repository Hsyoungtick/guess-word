create table public.word_bank (
  id uuid primary key default gen_random_uuid(),
  word text not null unique check (char_length(trim(word)) > 0),
  category text not null check (category in ('生活', '自然', '文化', '科技')),
  difficulty text not null check (difficulty in ('简单', '普通', '困难', '极难')),
  times_used bigint not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.rooms drop constraint if exists rooms_difficulty_check;
alter table public.rooms add constraint rooms_difficulty_check check (difficulty in ('简单', '普通', '困难', '极难'));
alter table public.rooms add column answer_word_id uuid references public.word_bank(id);

alter table public.word_bank enable row level security;
revoke all on public.word_bank from public, anon, authenticated;

insert into public.word_bank(word, category, difficulty) values
  ('苹果','生活','简单'),('雨伞','生活','简单'),('冰箱','生活','简单'),('牙刷','生活','简单'),('书包','生活','简单'),
  ('枕头','生活','简单'),('筷子','生活','简单'),('窗户','生活','简单'),('钥匙','生活','简单'),('毛巾','生活','简单'),
  ('熊猫','自然','简单'),('月亮','自然','简单'),('森林','自然','简单'),('河流','自然','简单'),('蝴蝶','自然','简单'),
  ('海洋','自然','简单'),('星星','自然','简单'),('沙漠','自然','简单'),('彩虹','自然','简单'),('企鹅','自然','简单'),
  ('音乐','文化','简单'),('电影','文化','简单'),('学校','文化','简单'),('春节','文化','简单'),('画画','文化','简单'),
  ('故事','文化','简单'),('足球','文化','简单'),('汉字','文化','简单'),('舞蹈','文化','简单'),('诗歌','文化','简单'),
  ('电脑','科技','简单'),('手机','科技','简单'),('机器人','科技','简单'),('网络','科技','简单'),('相机','科技','简单'),
  ('火箭','科技','简单'),('电池','科技','简单'),('芯片','科技','简单'),('卫星','科技','简单'),('耳机','科技','简单'),

  ('行李箱','生活','普通'),('榨汁机','生活','普通'),('便利店','生活','普通'),('保温杯','生活','普通'),('洗衣液','生活','普通'),
  ('晾衣架','生活','普通'),('快递柜','生活','普通'),('红绿灯','生活','普通'),('停车场','生活','普通'),('购物车','生活','普通'),
  ('珊瑚礁','自然','普通'),('向日葵','自然','普通'),('萤火虫','自然','普通'),('蒲公英','自然','普通'),('啄木鸟','自然','普通'),
  ('龙卷风','自然','普通'),('北极光','自然','普通'),('火山口','自然','普通'),('仙人掌','自然','普通'),('变色龙','自然','普通'),
  ('博物馆','文化','普通'),('交响乐','文化','普通'),('书法','文化','普通'),('京剧','文化','普通'),('寓言','文化','普通'),
  ('十二生肖','文化','普通'),('丝绸之路','文化','普通'),('图书馆','文化','普通'),('纪录片','文化','普通'),('传统节日','文化','普通'),
  ('人工智能','科技','普通'),('无人机','科技','普通'),('二维码','科技','普通'),('云计算','科技','普通'),('智能手表','科技','普通'),
  ('虚拟现实','科技','普通'),('搜索引擎','科技','普通'),('操作系统','科技','普通'),('充电宝','科技','普通'),('太阳能','科技','普通'),

  ('断舍离','生活','困难'),('仪式感','生活','困难'),('收纳空间','生活','困难'),('通勤','生活','困难'),('膳食纤维','生活','困难'),
  ('消费观','生活','困难'),('睡眠周期','生活','困难'),('生活节奏','生活','困难'),('公共交通','生活','困难'),('应急物资','生活','困难'),
  ('生态系统','自然','困难'),('食物链','自然','困难'),('候鸟迁徙','自然','困难'),('光合作用','自然','困难'),('大陆漂移','自然','困难'),
  ('生物多样性','自然','困难'),('季风气候','自然','困难'),('潮汐','自然','困难'),('共生关系','自然','困难'),('地质断层','自然','困难'),
  ('集体记忆','文化','困难'),('文化遗产','文化','困难'),('叙事视角','文化','困难'),('审美','文化','困难'),('民间传说','文化','困难'),
  ('象征主义','文化','困难'),('方言','文化','困难'),('非物质文化遗产','文化','困难'),('文艺复兴','文化','困难'),('现代主义','文化','困难'),
  ('机器学习','科技','困难'),('区块链','科技','困难'),('量子计算','科技','困难'),('神经网络','科技','困难'),('生物识别','科技','困难'),
  ('增强现实','科技','困难'),('自动驾驶','科技','困难'),('数据加密','科技','困难'),('物联网','科技','困难'),('基因编辑','科技','困难'),

  ('机会成本','生活','极难'),('认知偏差','生活','极难'),('延迟满足','生活','极难'),('沉没成本','生活','极难'),('情绪价值','生活','极难'),
  ('边际效用','生活','极难'),('幸存者偏差','生活','极难'),('信息茧房','生活','极难'),('社会时差','生活','极难'),('决策疲劳','生活','极难'),
  ('趋同进化','自然','极难'),('生态位','自然','极难'),('热盐环流','自然','极难'),('演替','自然','极难'),('地磁倒转','自然','极难'),
  ('物种形成','自然','极难'),('碳循环','自然','极难'),('板块俯冲','自然','极难'),('顶级捕食者','自然','极难'),('环境承载力','自然','极难'),
  ('互文性','文化','极难'),('陌生化','文化','极难'),('文化母题','文化','极难'),('结构主义','文化','极难'),('解构主义','文化','极难'),
  ('历史虚无主义','文化','极难'),('文化相对主义','文化','极难'),('意识流','文化','极难'),('符号学','文化','极难'),('口述史','文化','极难'),
  ('零知识证明','科技','极难'),('联邦学习','科技','极难'),('同态加密','科技','极难'),('边缘计算','科技','极难'),('数字孪生','科技','极难'),
  ('强化学习','科技','极难'),('生成对抗网络','科技','极难'),('容器编排','科技','极难'),('分布式共识','科技','极难'),('可解释人工智能','科技','极难');

create or replace function public.claim_word(p_category text, p_difficulty text)
returns table(word_id uuid, answer text)
language plpgsql security definer set search_path = public as $$
declare selected_id uuid; selected_word text;
begin
  select w.id, w.word into selected_id, selected_word
  from word_bank w
  where w.difficulty = p_difficulty
    and (p_category = '随机' or w.category = p_category)
  order by w.times_used asc, random()
  limit 1
  for update skip locked;
  if selected_id is null then raise exception 'WORD_BANK_EMPTY'; end if;
  update word_bank set times_used=times_used+1, last_used_at=clock_timestamp() where id=selected_id;
  return query select selected_id, selected_word;
end $$;

create or replace function public.start_game(p_code text, p_token_hash text, p_answer_ciphertext text, p_answer_word_id uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rooms; host players;
begin
  select * into r from rooms where code = p_code for update;
  if not found or r.status <> 'waiting' then raise exception 'ROOM_NOT_WAITING'; end if;
  select * into host from players where room_id = r.id and seat = 'A' and token_hash = p_token_hash;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if (select count(*) from players where room_id = r.id) <> 2 then raise exception 'ROOM_NOT_FULL'; end if;
  if not exists (select 1 from word_bank where id=p_answer_word_id) then raise exception 'WORD_NOT_FOUND'; end if;
  update rooms set status='playing', answer_ciphertext=p_answer_ciphertext, answer_word_id=p_answer_word_id,
    current_player_id=host.id, turn_number=1, turn_deadline=clock_timestamp()+interval '30 seconds',
    version=version+1, winner_id=null, updated_at=clock_timestamp()
    where id=r.id returning version into r.version;
  perform touch_room_event(p_code, r.version);
  return r.version;
end $$;

create or replace function public.request_rematch(p_code text, p_token_hash text)
returns boolean language plpgsql security definer set search_path=public as $$
declare r rooms; actor players; ready_count integer;
begin
  select * into r from rooms where code=p_code for update;
  if not found or r.status <> 'finished' then raise exception 'ROOM_NOT_FINISHED'; end if;
  select * into actor from players where room_id=r.id and token_hash=p_token_hash;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  update players set rematch_ready=true, last_seen_at=clock_timestamp() where id=actor.id;
  select count(*) into ready_count from players where room_id=r.id and rematch_ready;
  if ready_count = 2 then
    delete from guesses where room_id=r.id;
    update players set rematch_ready=false where room_id=r.id;
    update rooms set status='waiting',answer_ciphertext=null,answer_word_id=null,current_player_id=null,
      turn_deadline=null,turn_number=0,winner_id=null,version=version+1,updated_at=clock_timestamp()
      where id=r.id returning version into r.version;
    perform touch_room_event(p_code,r.version);
    return true;
  end if;
  update rooms set version=version+1,updated_at=clock_timestamp() where id=r.id returning version into r.version;
  perform touch_room_event(p_code,r.version);
  return false;
end $$;

revoke all on function public.claim_word(text, text) from public, anon, authenticated;
revoke all on function public.start_game(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_word(text, text) to service_role;
grant execute on function public.start_game(text, text, text, uuid) to service_role;
