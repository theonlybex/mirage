# Fonts

The fonts Mirage draws pop and karaoke captions and cards in. The render passes `files/` as the `ass` filter's
`fontsdir` (only for pop and karaoke captions and for cards); libass tries to open every file there as a font and loads
each into memory, so `files/` holds only these fonts. The licences and this readme stay here, beside it.

| File | What |
|---|---|
| files/Montserrat-ExtraBold.ttf | Montserrat ExtraBold, static TTF, release v7.222 of the Montserrat project (captions, bold cards) |
| OFL.txt | Its licence: SIL Open Font License 1.1 |
| files/JetBrainsMono-Regular.ttf | JetBrains Mono Regular, static TTF, release v2.304 of JetBrains Mono (mono cards; libass family `JetBrains Mono`) |
| OFL-JetBrainsMono.txt | Its licence: SIL Open Font License 1.1 |

## Montserrat

Source (tag `v7.222`, commit `5dae7a4ef9c0bf9fe48dc54fd1076eefaa0a8c7e`):

- https://raw.githubusercontent.com/JulietaUla/Montserrat/v7.222/fonts/ttf/Montserrat-ExtraBold.ttf
- https://raw.githubusercontent.com/JulietaUla/Montserrat/v7.222/OFL.txt

`shasum -a 256`:

```
1b364c3400bf7b1cc2c47a25dd0d3edd8331da451412aa5539080f78f8f70b63  files/Montserrat-ExtraBold.ttf
41f82bb4d24b304f30f7136bc47abdd083782e4265c984160f5649d1e78ea49c  OFL.txt
```

Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat). The font is unmodified.

## JetBrains Mono

Source: the release zip of tag `v2.304` (commit `cd5227bd1f61dff3bbd6c814ceaf7ffd95e947d9`,
https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304), from which
`fonts/ttf/JetBrainsMono-Regular.ttf` and `OFL.txt` (renamed OFL-JetBrainsMono.txt) were taken:

- https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip

`shasum -a 256`:

```
6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf  JetBrainsMono-2.304.zip
a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f  files/JetBrainsMono-Regular.ttf
30f0c136e3c88e422d0791acd97238870f9054a9729bc34cf2ff0d4ed8cac4ad  OFL-JetBrainsMono.txt
```

Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono). The font is unmodified.
