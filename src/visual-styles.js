/* 外観だけのプリセット。命令の配置、再生時刻、記録値は再生モデルと共通にする。 */
globalThis.sonataStyles = {
    neon: {
        label: "Neon", matte: false,
        palette: { integer:[.29,1,.81], memory:[1,.60,.22], branch:[.62,.43,1], red:[1,.19,.36], blue:[.30,.64,1], floor:[.08,.19,.24] },
        background: [.012,.022,.035],
        bounds: { active:"#71f5db",retiring:"#71f5db",inFlight:"#53b7af",badSpeculation:"#ff6277",frontend:"#80b7ff",backend:"#ffbb65",unresolved:"#8aa9b9",mixed:"#b0bfc8",unavailable:"#76838f" },
        timeline: ["#1d3946","#59bba9","#31525e"]
    },
    blocks: {
        label: "Blocks", matte: true,
        palette: { integer:[.16,.72,.48], memory:[.95,.64,.28], branch:[.69,.51,.93], red:[.94,.28,.34], blue:[.36,.65,.89], floor:[.84,.72,.52] },
        background: [.955,.936,.896],
        bounds: { active:"#287b60",retiring:"#287b60",inFlight:"#48877c",badSpeculation:"#bf3948",frontend:"#386d9c",backend:"#a3601c",unresolved:"#65716e",mixed:"#66645e",unavailable:"#716c63" },
        timeline: ["#c8d2ce","#43836b","#9aaca4"],
        // 大きな面は生成りと木肌、線と溝は茶灰色にし、活動の色を引き立てる。
        structure: { body:[.88,.845,.77], base:[.73,.64,.51], rail:[.91,.86,.75], recess:[.70,.645,.55], wire:[.48,.41,.33], ink:[.38,.32,.26] },
        surface: { wood:[.86,.76,.62], roughness:.60, grain:.06, light:[-.55,.85,-.4], pieceShadow:.44 }
    }
};
