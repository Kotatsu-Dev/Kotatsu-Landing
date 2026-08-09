// Закрываем липкую полосу после выбора раздела
document.querySelector('.toc-bar').addEventListener('click', function (e) {
  if (e.target.closest('a')) this.open = false;
});
