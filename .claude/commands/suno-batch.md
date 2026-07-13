あなたはSuno用楽曲プロンプトの量産システムです。以下の仕様に厳密に従い、$ARGUMENTS 曲分の楽曲プロンプトを生成してください。$ARGUMENTS が空または数値でない場合のみ、生成前に曲数を1回質問してください。

0. 成果物

* 出力先: `C:\Users\hiroy\youtube\和楽器グルーブ\suno_batch_{YYYYMMDD_HHmm}.md`（フォルダが無ければ作成する）
* 全曲を上記の1ファイルにまとめる。ファイル冒頭に「割当マトリクス一覧表」、末尾に「QAログ」を置く
* チャット画面には要約のみ出力する（曲数、軸の内訳、ファイルの絶対パス）。楽曲本文をチャットに繰り返さない

1. 固定DNA（全曲共通・変更禁止）

* 和楽器 × 60〜70年代日本のロック感覚: wagakki (shamisen, koto, shakuhachi, taiko, shinobue) meets Japanese retro rock
* upbeat, groovy, raw and energetic, catchy melody
* 歌詞は英詞、前向き・明るい内容のみ。ネガティブ・攻撃的表現は禁止
* 用途想定: 作業用BGM / ドライブ / ゲームBGM / ドラマ・映画挿入歌
* ボーカルは male vocal 基調（質感のみ軸Aに連動して変化可）

2. バリエーションマトリクス（4軸）

軸A: サブジャンル傾斜（6種・主役の和楽器も連動）

* A1 Psychedelic寄り: hypnotic swirling fuzz, detached vocal — lead: shakuhachi
* A2 Garage寄り: raw driving riffs, lo-fi edge, shouted vocal — lead: tsugaru shamisen
* A3 Surf / グループサウンズ寄り: twangy reverb guitar, sunny — lead: koto
* A4 Funk-groove寄り: syncopated bassline, wah guitar — lead: taiko + shamisen
* A5 Acid-folk寄り: jangly acoustic + electric blend, mellow-up — lead: shinobue
* A6 Freakbeat / Mod寄り: punchy drums, combo organ — lead: wadaiko ensemble

軸B: 楽曲構成（5種）

* B1 標準型: Intro–Verse1–Chorus–Verse2–Chorus–Bridge–Chorus–Outro
* B2 リフ主導型: 長尺のInstrumental Intro–Verse–Chorus–Solo（shamisen/guitar）–Chorus
* B3 転調ブリッジ型: Bridgeでキーまたはムードを転換して最終Chorusへ
* B4 コール&レスポンス型: 掛け声・レスポンスをChorusに組み込む
* B5 インスト重視型: 間奏2回以上・歌少なめ（作業用BGM特化）

軸C: 歌詞テーマ（8種から巡回）
夜のドライブ / 都会の朝 / 祭りの高揚 / 仕事の追い込みと達成 / 旅立ち / 仲間との疾走 / 季節の変わり目 / 星空と自由

軸D: メッセージ（5種から巡回）
挑戦 / 解放 / 今この瞬間を楽しむ / 再出発 / 連帯

3. 割当ルール（重複防止）

1. 生成を始める前に、N曲 × (A, B, C, D) の割当表を先に確定する
2. 各軸の巡回順をシャッフルして割り当てる。同一の (A, B) ペアの重複は N≦30 の範囲で禁止
3. 確定した割当表を出力ファイル冒頭にMarkdown表で記載する

4. 並列化ルール

* N > 8 の場合: 割当表の確定後、5曲ずつのバッチに分割し、Taskツールでサブエージェントを並列起動する。各サブエージェントには「固定DNA」「出力フォーマット」「担当する割当行」のみを渡す。回収した出力はメインが品質チェックしてから1ファイルに統合する
* N ≦ 8 の場合: 分割せずメインエージェントが直接生成する

5. 1曲あたりの出力フォーマット（Sunoコピペ用）

Track {番号:02d} — {英語タイトル}
割当: A{n} × B{n} × C: {テーマ} × D: {メッセージ} / BPM目安: {数値}

Style（SunoのStyle欄へコピペ）

```
{英語・カンマ区切り・120〜380文字。固定DNA＋軸Aの質感＋テンポ感＋ボーカル質感を含める。日本語・実在アーティスト名・実在曲名は禁止}
```

Exclude Styles（SunoのExclude欄へコピペ）

```
{そのスタイルを壊す要素を毎曲2〜4個。例: EDM, trap, autotune, polished modern pop}
```

Lyrics（SunoのLyrics欄へコピペ）

```
[Intro] [Verse 1] [Chorus] [Bridge] [Shamisen Solo] [Outro] 等の構造タグを必ず付け、軸Bの構成に厳密に従う。
Chorusのフックは口ずさめる短い1行を核にする。
B5の場合は [Instrumental Break] を2回以上入れ、歌詞行数を他の型の半分程度にする。
```

6. 品質チェック（統合後・書き出し前に必ず実行）

* タイトルの重複・先頭単語の一致がゼロであること
* 各曲のChorus 1行目が相互に非類似であること（同一単語が3語以上連続一致したら書き直し）
* Style文字列の完全一致がゼロであること
* ネガティブ・攻撃的表現がゼロであること
* 実在のアーティスト名・曲名を含まないこと（Suno側で弾かれるため）
* チェック結果と修正履歴をファイル末尾に「QAログ」として記載すること
