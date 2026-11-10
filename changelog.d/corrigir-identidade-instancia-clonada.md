### Added

- Adicionada operação local de prévia, aplicação e recuperação para separar a identidade de uma
  instância clonada, com novo ID, chaves e vínculo de proprietário, preservando conta e dados.
- O cadastro original permanece intacto. Falhas de cadastro mantêm o candidato recuperável e
  bloqueiam a publicação antiga. A ativação revoga sessões e convites herdados da cópia.
- Adicionado bloqueio de bootstrap vinculado ao ID original para que a primeira inicialização
  da cópia não recadastre a identidade antiga antes de o operador executar a separação.
