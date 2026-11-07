# Fonts

The font Mirage draws pop and karaoke captions in. The render passes `files/` as the `ass` filter's `fontsdir` (only for
pop and karaoke captions); libass tries to open every file there as a font and loads each into memory, so `files/` holds
only the caption font. The licence and this readme stay here, beside it.

| File | What |
|---|---|
| files/Montserrat-ExtraBold.ttf | Montserrat ExtraBold, static TTF, release v7.222 of the Montserrat project |
| OFL.txt | Its licence: SIL Open Font License 1.1 |

Source (tag `v7.222`, commit `5dae7a4ef9c0bf9fe48dc54fd1076eefaa0a8c7e`):

- https://raw.githubusercontent.com/JulietaUla/Montserrat/v7.222/fonts/ttf/Montserrat-ExtraBold.ttf
- https://raw.githubusercontent.com/JulietaUla/Montserrat/v7.222/OFL.txt

`shasum -a 256`:

```
1b364c3400bf7b1cc2c47a25dd0d3edd8331da451412aa5539080f78f8f70b63  files/Montserrat-ExtraBold.ttf
41f82bb4d24b304f30f7136bc47abdd083782e4265c984160f5649d1e78ea49c  OFL.txt
```

Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat). The font is unmodified.
