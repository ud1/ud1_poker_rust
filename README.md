# Scrum poker

## Config file 
File `config.ini`
```
[net]
addr=0.0.0.0:16000

[cards]
cards=0 0.5 1 2 3 5 8 10 15
```

## Linux build

```
cd web
npm run createProductionBundle
cd ../
RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --target x86_64-unknown-linux-gnu
```


