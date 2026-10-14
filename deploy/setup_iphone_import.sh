#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --no-install-recommends -y openssl samba

if ! getent group vita29data >/dev/null 2>&1; then
    groupadd --gid 10001 vita29data
fi
if ! id vitaiphone >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin --gid vita29data vitaiphone
fi

install -d -o vitaiphone -g vita29data -m 2770 /srv/vita29/import/iphone
install -d -o vitaiphone -g vita29data -m 2770 /srv/vita29/import/iphone/.duplicates
install -d -o vitaiphone -g vita29data -m 2770 /srv/vita29/import/iphone/.errors
install -m 0644 /opt/vita29/deploy/samba-vita29-import.conf /etc/samba/vita29-import.conf

if ! grep -Fq "include = /etc/samba/vita29-import.conf" /etc/samba/smb.conf; then
    sed -i '/^\[global\]/a\   include = /etc/samba/vita29-import.conf' /etc/samba/smb.conf
fi

credentials=/root/vita29-smb-credentials
if [ ! -s "$credentials" ]; then
    password="V29-$(openssl rand -hex 10)"
    printf '%s\n%s\n' "$password" "$password" | smbpasswd -s -a vitaiphone
    umask 077
    {
        printf 'server=smb://192.168.1.212\n'
        printf 'share=iphone-import\n'
        printf 'username=vitaiphone\n'
        printf 'password=%s\n' "$password"
    } > "$credentials"
fi

testparm -s >/dev/null
systemctl enable --now smbd
systemctl restart smbd

install -d -o root -g root -m 0755 /srv/vita29/geonames
if [ ! -s /srv/vita29/geonames/cities500.txt ]; then
    python3 /opt/vita29/deploy/setup_geonames.py
fi
