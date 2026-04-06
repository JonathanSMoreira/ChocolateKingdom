# -*- coding: utf-8 -*-
"""
Gera DOCFUNCIONALIDADES_PT-BR.docx e DOCFUNCIONALIDADES_EN.docx.
Executar na raiz do projeto:
  python docs/generate_funcionalidades_word.py
Requisito:
  pip install python-docx
"""
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt


def set_doc_defaults(doc: Document) -> None:
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(11)


def add_title(doc: Document, text: str) -> None:
    p = doc.add_heading(text, 0)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER


def add_h(doc: Document, text: str, level: int = 1) -> None:
    doc.add_heading(text, level=level)


def add_p(doc: Document, text: str) -> None:
    doc.add_paragraph(text)


def build_pt() -> Document:
    doc = Document()
    set_doc_defaults(doc)
    add_title(doc, "Cacau Parque — Documentacao do projeto")

    add_p(
        doc,
        "As partes 1 e 2 usam linguagem acessivel; a parte 3 descreve arquitetura e organizacao do codigo "
        "(cliente, servidor, pastas principais e tecnologias).",
    )

    add_h(doc, "Parte 1 — Explicacao simples (leigos)", 1)
    add_h(doc, "Objetivo do app", 2)
    add_p(
        doc,
        "O app Cacau Parque foi criado para apresentar a experiencia de um parque tematico no celular: "
        "explorar atracoes, visualizar mapa, criar conta, fazer login e gerir perfil.",
    )
    add_h(doc, "O que ele faz hoje", 2)
    add_p(doc, "Home: vitrine do parque com destaques de lojas, eventos e atracoes.")
    add_p(doc, "Ingressos: area visual, ainda em evolucao para compra real.")
    add_p(doc, "Mapa: visualizacao com zoom e pontos tocaveis com informacoes.")
    add_p(doc, "Perfil: login, cadastro, edicao de dados, foto, endereco e saida da conta.")
    add_h(doc, "Linguagens e tecnologias (em termos simples)", 2)
    add_p(doc, "Celular: React Native com Expo (app multiplataforma).")
    add_p(doc, "Servidor: Node.js com Express (responde as requisicoes).")
    add_p(doc, "Banco de dados: Microsoft SQL Server (onde os dados ficam guardados).")

    add_h(doc, "Parte 2 — Funcionalidades por pagina", 1)
    add_h(doc, "Home", 2)
    add_p(
        doc,
        "Tela inicial com identidade visual, secoes em carrossel e atalhos que encaminham para o mapa filtrado.",
    )
    add_h(doc, "Ingressos", 2)
    add_p(doc, "Tela de placeholder com identidade visual; compra ainda nao habilitada nesta versao.")
    add_h(doc, "Mapa", 2)
    add_p(
        doc,
        "Gestos de arrasto e zoom, hotspots com detalhes e fallback para dados locais quando API falha.",
    )
    add_h(doc, "Perfil", 2)
    add_p(
        doc,
        "Fluxos de autenticacao, dados pessoais e recursos extras para perfis marcados como funcionarios.",
    )

    add_h(doc, "Parte 3 — Arquitetura e organizacao do codigo", 1)
    add_h(doc, "Arquitetura geral", 2)
    add_p(
        doc,
        "Modelo cliente-servidor: aplicativo React Native consome API REST em Node/Express, "
        "que persiste dados no SQL Server.",
    )
    add_h(doc, "Organizacao por area", 2)
    add_p(
        doc,
        "Backend: pastas routes/, services/, utils/, schema/, workers/ e ficheiro db/connection.js; "
        "parte da logica continua concentrada em server.js.",
    )
    add_p(
        doc,
        "App React Native: modulos em src/ incluem config, types, services/http, utils, map/ e screens/MapaTab.tsx; "
        "App.tsx concentra grande parte do codigo da interface.",
    )
    add_p(
        doc,
        "API: existem health check, timeout em chamadas, mensagens de diagnostico para ligacao SQL e uso de variaveis em .env.",
    )
    add_h(doc, "Tipos de linguagem usados no projeto", 2)
    add_p(doc, "TypeScript e JavaScript no app e backend.")
    add_p(doc, "SQL para schema, migracoes e seeds.")
    add_p(doc, "PowerShell/BAT para automacoes de ambiente SQL e suporte operacional.")

    return doc


def build_en() -> Document:
    doc = Document()
    set_doc_defaults(doc)
    add_title(doc, "Cacau Parque — Project documentation")

    add_p(
        doc,
        "Parts 1 and 2 use plain language; Part 3 describes architecture and code organisation "
        "(client, server, main folders, and technologies).",
    )

    add_h(doc, "Part 1 — Plain-language overview", 1)
    add_h(doc, "App objective", 2)
    add_p(
        doc,
        "Cacau Parque is a mobile app designed to present a theme-park experience: explore attractions, "
        "view a map, create an account, sign in, and manage profile data.",
    )
    add_h(doc, "What it does today", 2)
    add_p(doc, "Home: showcase content for attractions, stores, and events.")
    add_p(doc, "Tickets: visual placeholder, real purchase flow still in progress.")
    add_p(doc, "Map: zoom/pan map with tappable points of interest.")
    add_p(doc, "Profile: login, registration, profile editing, photo and address updates.")
    add_h(doc, "Languages and technologies (simple terms)", 2)
    add_p(doc, "Mobile app: React Native + Expo.")
    add_p(doc, "API server: Node.js + Express.")
    add_p(doc, "Database: Microsoft SQL Server.")

    add_h(doc, "Part 2 — Features by screen", 1)
    add_h(doc, "Home", 2)
    add_p(doc, "Brand-led entry screen with carousels and shortcuts that can open filtered map views.")
    add_h(doc, "Tickets", 2)
    add_p(doc, "Placeholder screen with themed visual identity; checkout flow not enabled in this build.")
    add_h(doc, "Map", 2)
    add_p(doc, "Custom pan/zoom interactions, hotspot details, API fetch with local fallback data.")
    add_h(doc, "Profile", 2)
    add_p(doc, "Authentication flows, personal data management, and extra capabilities for employee-tagged accounts.")

    add_h(doc, "Part 3 — Architecture and code organisation", 1)
    add_h(doc, "Overall architecture", 2)
    add_p(
        doc,
        "Client-server architecture: React Native app consumes a Node/Express REST API; data is stored in SQL Server.",
    )
    add_h(doc, "Organisation by area", 2)
    add_p(
        doc,
        "Backend: directories routes/, services/, utils/, schema/, workers/, and file db/connection.js; "
        "a significant amount of logic still lives in server.js.",
    )
    add_p(
        doc,
        "React Native app: modules under src/ include config, types, http services, utils, map/, and screens/MapaTab.tsx; "
        "App.tsx holds most of the UI-related code.",
    )
    add_p(
        doc,
        "API: health check endpoint, request timeouts, SQL connection troubleshooting messages, and configuration via .env variables.",
    )
    add_h(doc, "Language types used in the project", 2)
    add_p(doc, "TypeScript and JavaScript across mobile and backend layers.")
    add_p(doc, "SQL for schema, migrations, and seed data.")
    add_p(doc, "PowerShell/BAT scripts for SQL environment setup and operations.")

    return doc


def _save_doc(doc: Document, root: Path, name: str) -> None:
    path = root / name
    try:
        doc.save(str(path))
        print("OK:", path)
    except OSError:
        alt = root / name.replace(".docx", "_novo.docx")
        doc.save(str(alt))
        print("OK (arquivo aberto no Word; salvo como):", alt)


def main() -> None:
    root = Path(__file__).resolve().parent
    _save_doc(build_pt(), root, "DOCFUNCIONALIDADES_PT-BR.docx")
    _save_doc(build_en(), root, "DOCFUNCIONALIDADES_EN.docx")


if __name__ == "__main__":
    main()
