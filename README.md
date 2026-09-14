# Sagechat

Local agentic web chat di atas [9Router](https://github.com/decolua/9router) — chat streaming, tool-loop shell sandbox, dan konektor GitHub, semua jalan di HP/laptop kamu sendiri lewat Flask.

---

## 🤝 Kontribusi & Fork

Project ini terbuka untuk siapa saja yang mau dipakai, dimodif, atau dikembangkan lebih jauh.

- **Fork dulu, PR kemudian.** Jangan push langsung ke `main`.
- Kenapa fork? Supaya ada jarak buat **saling review** — perubahan (apalagi yang nyentuh `execute_shell()` atau `execute_github()`) sebaiknya dibaca minimal satu orang lain sebelum masuk ke branch utama.
- Laporkan bug/ide fitur lewat Issues. Sertakan langkah reproduksi kalau soal error.
- PR kecil & fokus pada satu perubahan lebih gampang direview daripada PR raksasa.

---

## Perkenalan

**Sagechat** adalah backend + UI web ringan (single Flask app, satu file `server.py` + satu `index.html`) yang berfungsi sebagai *frontend chat* untuk model AI yang kamu akses lewat **9Router** (proxy OpenAI-compatible ke banyak provider — termasuk opsi gratis).

Bukan cuma chat biasa, Sagechat punya **mode agent**: model bisa minta menjalankan perintah shell di dalam sandbox lokal, atau melakukan operasi baca/tulis ke repo GitHub — dengan **permission-gate** di setiap aksi yang berisiko, jadi tidak ada yang jalan diam-diam tanpa persetujuan kamu.

Cocok dijalankan di laptop maupun di HP Android lewat Termux.

### Fitur utama (ringkas)

| Fitur | Keterangan |
|---|---|
| Chat streaming (SSE) | Respons model muncul kata-per-kata, real-time |
| Tool loop agent | Model bisa "memanggil" shell atau GitHub, hasilnya dibaca balik oleh model |
| Sandbox shell | Command jalan di folder `workspace/` yang terisolasi; keluar dari situ wajib izin |
| Konektor GitHub | Baca/tulis file, buat branch, buat PR, trigger workflow — semua aksi tulis wajib konfirmasi manual |
| Riwayat sesi | Multi-chat, bisa di-rename, di-fork, dan di-export ke Markdown/JSON |
| Memori sederhana | Catatan permanen yang selalu disisipkan ke system prompt |
| Upload gambar/file | Termasuk deteksi otomatis model *vision* |
| Statistik token | Total token, per model, per sesi |
| Mode agent on/off | Kalau dimatikan, Sagechat jadi chat biasa tanpa tool sama sekali |

---

## Versi

Belum ada tag rilis resmi — anggap ini **v0.1.0 (development)**. Cek commit terakhir di repo kamu sendiri untuk versi paling update, dan update baris ini begitu kamu bikin tag rilis pertama.

---

## Cara Install

### 1) Siapkan 9Router dulu (di Termux)

9Router adalah "otak" yang menghubungkan Sagechat ke model AI. Install ini duluan sebelum Sagechat.

```bash
pkg update && pkg upgrade
pkg install nodejs git -y

# install 9Router secara global
npm install -g 9router

# jalankan
9router
```

Setelah jalan, dashboard 9Router otomatis kebuka di:

```
http://localhost:20128
```

**Setup provider di dashboard 9Router:**

1. Buka dashboard → menu **Providers**.
2. Rekomendasi: pilih **OpenCode Free** (tidak butuh login/akun, langsung jalan, dan gratis) untuk mulai cepat. Kamu bisa tambah provider lain belakangan kalau perlu model spesifik.
3. Setelah provider terhubung, buka menu **Endpoint** / **Dashboard** → copy **API Key** yang ditampilkan di sana. Key ini yang nanti dipakai Sagechat.

> Simpan API key ini baik-baik, jangan pernah di-commit ke Git.

### 2) Install Sagechat

Masih di sesi Termux yang sama (atau terminal baru):

```bash
git clone https://github.com/rixz-dev/SageChat-.git
cd SageChat

# install dependency Python
pip install -r requirements.txt
```

### 3) Jalankan

```bash
python server.py
```

Kalau berhasil akan muncul log:

```
Sagechat jalan di http://127.0.0.1:5057  (data: .../data)
```

Buka URL itu (`http://127.0.0.1:5057` atau `http://localhost:5057`) di browser HP/laptop kamu.

---

## Cara Pakai

### Konfigurasi awal (wajib sekali di awal)

1. Buka Sagechat di browser → klik ikon **⚙️ Settings**.
2. Isi:
   - **Router URL (9Router)** → default `http://localhost:20128`, biarkan kalau 9Router jalan di device yang sama.
   - **Router API Key** → tempel API key yang tadi di-copy dari dashboard 9Router.
   - (Opsional) **GitHub Token** dan **GitHub Repo** — lihat bagian [Konektor GitHub](#konektor-github) di bawah.
   - (Opsional) **Sandbox dir** — folder tempat command shell agent dijalankan (default: `workspace/` di dalam folder Sagechat).
3. Simpan.
4. Klik **Pilih model** → pilih model yang mau dipakai (daftar model diambil otomatis dari 9Router).
5. Mulai ngobrol dari kotak chat di bawah.

### Konektor GitHub

Sagechat bisa baca *dan* tulis ke repo GitHub kamu, tapi **hanya kalau kamu sendiri yang mengizinkan**. Supaya aman, gunakan **fine-grained personal access token** yang scope-nya dibatasi ke **1 repo saja** — bukan classic token yang aksesnya ke semua repo kamu.

**Cara ambil token fine-grained (scope 1 repo):**

1. Login ke GitHub → klik foto profil (kanan atas) → **Settings**.
2. Di page profil nanti muncul logo menu diatas foto profil mu yang gede itu,  pencet tombol menu itu > Scroll ke bawah kiri → **Developer settings**.
3. Pilih **Personal access tokens → Fine-grained tokens**.
4. Klik **Generate new token**.
5. Isi:
   - **Token name** → misal `sagechat-<nama-repo>`.
   - **Expiration** → pilih durasi wajar (30–90 hari), jangan "No expiration".
   - **Repository access** → pilih **Only select repositories**, lalu pilih **satu repo** yang mau dihubungkan ke Sagechat.
6. Di **Permissions**, set sesuai kebutuhan (minimal yang dipakai Sagechat):
   - **Contents** → Read and write (untuk baca/tulis/hapus file, buat branch)
   - **Pull requests** → Read and write (untuk `create_pr`)
   - **Actions** → Read and write *(hanya kalau mau pakai fitur trigger workflow)*
7. Klik **Generate token**, lalu **copy tokennya sekarang juga** — GitHub cuma nampilin sekali.
8. Tempel token itu ke field **GitHub Token** di Settings Sagechat, isi juga **GitHub Repo** dengan format `owner/nama-repo`.

Setelah tersambung, kamu bisa:
- Minta AI di chat untuk baca/ubah file di repo (dia akan menampilkan permintaan izin sebelum benar-benar menulis).
- Atau buka panel **GitHub** di menu (ikon `+`) untuk browse file, edit manual, commit, buat PR, atau trigger GitHub Actions workflow langsung dari UI — aksi lewat panel ini dianggap sudah "kamu yang klik sendiri" jadi tidak muncul dialog izin tambahan.

---

## Penjelasan Fitur di Web UI

**Sidebar kiri (Riwayat)**
- **+ Obrolan baru** — mulai sesi chat baru.
- Daftar sesi sebelumnya, klik untuk buka kembali.

**Header atas**
- **☰** — buka/tutup sidebar riwayat.
- **Log aktivitas** — panel log yang menampilkan proses berpikir (reasoning) model dan detail tool-call, berguna buat debug kenapa model memutuskan sesuatu.
- **⚙️ Settings** — konfigurasi Router URL, API key, GitHub token/repo, dan sandbox dir (lihat di atas).

**Kotak chat bawah**
- Textarea untuk nulis pesan, kirim dengan tombol panah.
- **Pilih model** — dropdown model aktif untuk sesi ini.
- **+ (plus)** — buka menu cepat:
  - **Lampirkan gambar** / **Lampirkan file** — upload attachment ke pesan berikutnya. Gambar otomatis dikirim sebagai input visual kalau model yang dipilih terdeteksi mendukung vision.
  - **Model** — shortcut ke pemilih model.
  - **Statistik** — lihat pemakaian token: total keseluruhan, per model, per sesi.
  - **GitHub** — buka panel konektor GitHub (lihat di atas).
  - **Mode Agent** (toggle) — kalau **ON**, model boleh menjalankan shell/GitHub tool. Kalau **OFF**, Sagechat jadi chatbot biasa tanpa kemampuan eksekusi apa pun.
  - **Memori** — tambah/hapus catatan permanen yang selalu ikut terkirim ke model sebagai konteks (misal preferensi kerja, info project).
  - **Export** — unduh isi obrolan sebagai Markdown atau JSON.
  - **Fork** — duplikat sesi saat ini jadi sesi baru (berguna buat coba cabang percakapan tanpa merusak yang asli).

**Dialog izin (permission request)**
Muncul otomatis di tengah chat setiap kali model minta:
- menjalankan command **di luar** folder sandbox, atau
- melakukan **aksi tulis apa pun** ke GitHub (create/update/delete file, buat branch, buat PR, trigger workflow) — ini berlaku tanpa kecuali, termasuk ke file `.github/workflows/`.

Kamu tinggal klik **Izinkan** atau **Tolak**. Tidak ada aksi berisiko yang jalan tanpa klik ini dari kamu.

---

## Keamanan & Sandbox

- Semua command shell dari agent secara default dibatasi ke folder `sandbox_dir` (default `workspace/`). Keluar dari situ = wajib izin manual.
- Semua aksi tulis GitHub wajib konfirmasi manual, tanpa pengecualian — ini kebijakan tetap, bukan bug.
- Token GitHub dan API key 9Router disimpan lokal di `data/config.json` di device kamu sendiri — **jangan commit folder `data/` ke Git.** Tambahkan ke `.gitignore`.
- Gunakan token GitHub fine-grained dengan scope 1 repo dan masa berlaku terbatas, bukan classic token full-access.

---

## Struktur Data Lokal

```
sagechat/
├── server.py
├── requirements.txt
├── static/index.html
├── workspace/          # sandbox shell agent
└── data/
    ├── config.json     # router url, api key, github token/repo (JANGAN di-commit)
    ├── memory.json
    ├── stats.json
    ├── chats/*.json    # riwayat per sesi
    └── uploads/        # lampiran gambar/file
```

---

## Lisensi

Dirilis di bawah **GNU General Public License v3.0 (GPL-3.0)**. Bebas dipakai, dimodifikasi, dan didistribusikan ulang, selama turunannya tetap ikut lisensi yang sama dan tetap open source. Lihat file `LICENSE` untuk teks lengkap.
