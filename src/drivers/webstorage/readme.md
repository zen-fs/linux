# Web Storage

The `webstorage` module is built in, so nothing needs to be done to use it.
It exposes block devices for `Storage` APIs, namely `/dev/localStorage` and `/dev/sessionStorage`.

`Storage` doesn't expose how much room it has, so a disk is as big as the `size` parameter claims.
