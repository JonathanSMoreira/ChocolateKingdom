# People Analytics — Power BI | Choco Kingdom

> **Portfolio:** cenário corporativo de exemplo com dados fictícios (RH / pessoas). Secções em **EN** e **PT**.

---

## English

Two complementary report pages:

- **Operational — “Workforce by sector”** — Day-to-day: attendance by sector over time, headcount / hires / terminations, split between **unjustified absences** and **medical certificates**, and a detailed employee table for line managers.
- **Strategic — “Global vision of people”** — Executive view: KPI cards (people, customers, employees, countries), **map**, age bands (customers vs employees), gender-split sign-up growth, country table.

**Stack:** Power Query, dimensional model (dimensions + fact), **DAX** (time intelligence, HR metrics), layout for two audiences (coordinator vs leadership). **SQL Server** for business-rule validation alongside the semantic model.

Screenshots (same files as the root `README.md`):

| Strategic | Operational |
| :---: | :---: |
| ![Strategic](readme/power-bi-strategic-global-vision.png) | ![Operational](readme/power-bi-operational-workforce-by-sector.png) |

---

## Português

Duas páginas de relatório que se complementam:

- **Operacional — “Workforce by sector”** — Dia a dia: presença por setor, quadro (headcount, admissões, desligamentos), **falta** vs **atestado**, tabela por colaborador.
- **Estratégica — “Global vision of people”** — Macro: KPIs, **mapa**, idades (clientes vs funcionários), crescimento de cadastros por género, países.

**Stack:** Power Query, modelo dimensional, **DAX**, UI por persona. **SQL Server** para validar regras de negócio.

As mesmas imagens em `docs/readme/`:

| Estratégica | Operacional |
| :---: | :---: |
| ![Estratégica](readme/power-bi-strategic-global-vision.png) | ![Operacional](readme/power-bi-operational-workforce-by-sector.png) |

---

## SQL — absenteísmo (denominador sem folgas)

Granularidade típica: **um registo por colaborador por dia** (`PontoEletronicoDia` ou equivalente no teu schema).

```sql
-- Padrão simplificado: faltas só em dias que não são folgas marcadas
SELECT
  SUM(CASE WHEN Falta = 1 THEN 1 ELSE 0 END) * 1.0
    / NULLIF(SUM(CASE WHEN Folga = 0 THEN 1 ELSE 0 END), 0) AS AbsenteeismRate
FROM PontoEletronicoDia;
```
